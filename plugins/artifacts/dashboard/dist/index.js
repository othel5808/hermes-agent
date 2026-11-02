/**
 * Hermes Artifacts — Dashboard Plugin  (B2a)
 *
 * 2-pane master-detail UI for browsing images, documents, and kanban
 * attachments collected by the artifacts plugin backend.
 *
 * Plain IIFE, no build step.  Uses window.__HERMES_PLUGIN_SDK__ for
 * React + ReactDOM; calls the plugin backend exclusively via
 * SDK.authedFetch (token never in URL or DOM).
 *
 * B2a scope:
 *   - Project tabs  (GET /projects)
 *   - Source/kind filter + debounced search
 *   - Left list pane: group headers, file rows, lazy thumbnails,
 *     ↑↓ keyboard nav, collapse toggle
 *   - cursor pagination (IntersectionObserver sentinel),
 *     truncated banner, 404-safe cursor restart
 *   - Right preview pane: meta header only (B2b adds content render)
 *   - Compare checkboxes + bottom chip tray state (B2c adds grid)
 *   - Download via authedFetch → Blob URL (no token in URL)
 *   - Toast for 422, compare-max, download errors
 *   - Mobile: full-screen list → tap → full-screen preview
 */
(function () {
  "use strict";

  // ── SDK guard ──────────────────────────────────────────────────────────────
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;

  var React      = SDK.React;
  var authedFetch = SDK.authedFetch;
  var h = React.createElement;

  var useState     = SDK.hooks.useState;
  var useEffect    = SDK.hooks.useEffect;
  var useCallback  = SDK.hooks.useCallback;
  var useRef       = SDK.hooks.useRef;
  var useMemo      = SDK.hooks.useMemo;

  // ── Utilities ──────────────────────────────────────────────────────────────

  function timeAgo(ts) {
    if (!ts) return "";
    var now  = Math.floor(Date.now() / 1000);
    var diff = now - ts;
    if (diff < 60)     return "방금 전";
    if (diff < 3600)   return Math.floor(diff / 60) + "분 전";
    if (diff < 86400)  return Math.floor(diff / 3600) + "시간 전";
    if (diff < 604800) return Math.floor(diff / 86400) + "일 전";
    var d = new Date(ts * 1000);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024)    return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  var KIND_EMOJI = { image: "🖼", doc: "📄", text: "📝", other: "🗂" };
  function kindEmoji(k) { return KIND_EMOJI[k] || "🗂"; }

  function srcDotClass(source) {
    var s = source || "other";
    return "art-src-dot art-src-" + s;
  }

  function isDownloadOnly(item) {
    var name = (item.name || "").toLowerCase();
    return (
      name.endsWith(".svg") || name.endsWith(".html") || name.endsWith(".htm") ||
      item.kind === "other"
    );
  }

  // ── API layer ──────────────────────────────────────────────────────────────

  var API = "/api/plugins/artifacts";

  function apiFetch(path, opts) {
    return authedFetch(API + path, opts || {});
  }

  function fetchProjects() {
    return apiFetch("/projects").then(function (r) {
      if (!r.ok) throw Object.assign(new Error("projects " + r.status), { status: r.status });
      return r.json();
    });
  }

  function fetchItems(params) {
    var qs = new URLSearchParams();
    if (params.project && params.project !== "all") qs.set("project", params.project);
    if (params.source  && params.source  !== "all") qs.set("source",  params.source);
    if (params.kind    && params.kind    !== "all") qs.set("kind",    params.kind);
    if (params.q)       qs.set("q",      params.q.slice(0, 100));
    if (params.cursor)  qs.set("cursor", params.cursor);
    qs.set("limit", "50");
    return apiFetch("/items?" + qs.toString()).then(function (r) {
      if (r.status === 422) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          throw Object.assign(new Error("422"), { status: 422, body: body });
        });
      }
      if (!r.ok) throw Object.assign(new Error("items " + r.status), { status: r.status });
      return r.json();
    });
  }

  // Requery an item by rel_path (for 404 cache-miss recovery; used by B2b).
  // Searches the current filters to find the refreshed item with the same
  // rel_path, then returns it (caller can retry /content/<new_id>).
  // Exposed on window.__HERMES_ARTIFACTS__ for the B2b content renderer.
  function refetchItem(item, params) {
    var p = params || {};
    var qs = new URLSearchParams();
    if (p.project && p.project !== "all") qs.set("project", p.project);
    if (p.source  && p.source  !== "all") qs.set("source",  p.source);
    if (p.kind    && p.kind    !== "all") qs.set("kind",    p.kind);
    if (item.name) qs.set("q", item.name.slice(0, 100));
    qs.set("limit", "20");
    return apiFetch("/items?" + qs.toString()).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (data) {
        return (data.items || []).find(function (i) {
          return i.rel_path === item.rel_path;
        }) || null;
      });
    }).catch(function () { return null; });
  }

  // Authenticated download: Blob URL → invisible <a> click.
  function triggerDownload(id, name) {
    return apiFetch("/content/" + id + "?download=1").then(function (r) {
      if (!r.ok) return false;
      return r.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = name || id;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        return true;
      });
    }).catch(function () { return false; });
  }

  // Expose helpers for B2b/B2c without re-bundling.
  if (typeof window !== "undefined") {
    window.__HERMES_ARTIFACTS__ = {
      apiFetch:      apiFetch,
      refetchItem:   refetchItem,
      triggerDownload: triggerDownload,
      timeAgo:       timeAgo,
      fmtSize:       fmtSize,
    };
  }

  // ── Thumbnail component ────────────────────────────────────────────────────
  //
  // Shows the kind emoji immediately, then attempts a lazy authedFetch of
  // the content endpoint for image/* items.  Blob URL is revoked on unmount.

  function Thumbnail(props) {
    var item = props.item;
    var imgSrcRef = useRef(null);
    var mountedRef = useRef(true);
    var _s = useState(null);
    var blobUrl = _s[0]; var setBlobUrl = _s[1];
    var _f = useState(false);
    var failed = _f[0]; var setFailed = _f[1];

    useEffect(function () {
      mountedRef.current = true;
      if (item.kind !== "image" || failed) return;
      var localUrl = null;
      apiFetch("/content/" + item.id)
        .then(function (r) {
          if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status });
          return r.blob();
        })
        .then(function (blob) {
          if (!mountedRef.current) return;
          localUrl = URL.createObjectURL(blob);
          imgSrcRef.current = localUrl;
          setBlobUrl(localUrl);
        })
        .catch(function (err) {
          if (!mountedRef.current) return;
          // 404: 1회 재조회 — 서버 재시작 후 stale id 복구.
          // 그 외 오류: 즉시 실패.
          if (err.status !== 404) { setFailed(true); return; }
          refetchItem(item).then(function (refreshed) {
            if (!mountedRef.current) return;
            // rel_path가 같은 새 항목을 못 찾거나 id가 동일하면 포기
            if (!refreshed || refreshed.id === item.id) { setFailed(true); return; }
            return apiFetch("/content/" + refreshed.id)
              .then(function (r2) {
                if (!r2.ok || !mountedRef.current) { setFailed(true); return; }
                return r2.blob().then(function (blob) {
                  if (!mountedRef.current) return;
                  localUrl = URL.createObjectURL(blob);
                  imgSrcRef.current = localUrl;
                  setBlobUrl(localUrl);
                });
              })
              .catch(function () { if (mountedRef.current) setFailed(true); });
          }).catch(function () { if (mountedRef.current) setFailed(true); });
        });
      return function () {
        mountedRef.current = false;
        if (localUrl) URL.revokeObjectURL(localUrl);
      };
    }, [item.id, item.kind]);

    var dlOnly = isDownloadOnly(item);

    return h("div", { className: "art-thumb" },
      (item.kind === "image" && blobUrl)
        ? h("img", { src: blobUrl, alt: item.name, loading: "lazy" })
        : h("span", { style: { fontSize: "16px" } }, kindEmoji(item.kind)),
      dlOnly && h("span", { className: "art-dl-only" }, "↓ only")
    );
  }

  // ── FileRow component ──────────────────────────────────────────────────────

  function FileRow(props) {
    var item         = props.item;
    var isSelected   = props.isSelected;
    var isCompared   = props.isCompared;
    var onSelect     = props.onSelect;
    var onToggleCompare = props.onToggleCompare;

    function handleKeyDown(e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(item);
      }
    }

    var cls = [
      "art-file-row",
      isSelected ? "selected" : "",
      item.orphan  ? "orphan"   : "",
    ].filter(Boolean).join(" ");

    return h("div", {
      className: cls,
      role: "option",
      "aria-selected": isSelected,
      tabIndex: 0,
      "data-id": item.id,
      onClick: function () { onSelect(item); },
      onKeyDown: handleKeyDown,
    },
      h("input", {
        type: "checkbox",
        className: "art-compare-check",
        "aria-label": "비교 선택",
        checked: !!isCompared,
        readOnly: true,
        onClick: function (e) {
          e.stopPropagation();
          onToggleCompare(item);
        },
      }),
      h(Thumbnail, { item: item }),
      h("div", { className: "art-row-info" },
        h("span", { className: "art-row-name", title: item.name }, item.name),
        h("div", { className: "art-row-meta" },
          h("span", { className: srcDotClass(item.source) }),
          h("span", null, fmtSize(item.size)),
          h("span", { className: "art-sep" }, "·"),
          h("span", null, timeAgo(item.mtime)),
          h("span", { className: "art-kind-badge" }, item.kind),
          item.orphan && h("span", { className: "art-orphan-badge" }, "원본 없음")
        )
      )
    );
  }

  // ── SkeletonRow component ──────────────────────────────────────────────────

  function SkeletonRow() {
    return h("div", { className: "art-file-row", style: { pointerEvents: "none" } },
      h("div", { className: "art-thumb art-skeleton" }),
      h("div", { className: "art-row-info" },
        h("div", { className: "art-skeleton",
          style: { height: "12px", width: "60%", borderRadius: "4px", marginBottom: "4px" } }),
        h("div", { className: "art-skeleton",
          style: { height: "10px", width: "40%", borderRadius: "4px" } })
      )
    );
  }

  // ── Toast component ────────────────────────────────────────────────────────

  function Toast(props) {
    var msg = props.message;
    var onClose = props.onClose;
    useEffect(function () {
      var t = setTimeout(onClose, 3500);
      return function () { clearTimeout(t); };
    }, [msg]);
    return h("div", { className: "art-toast", role: "alert" }, msg);
  }

  // ── TopBar component ───────────────────────────────────────────────────────

  function TopBar(props) {
    var projects        = props.projects;
    var unassignedCount = props.unassignedCount;
    var activeProject   = props.activeProject;
    var onSelect        = props.onSelect;
    var loading         = props.loading;

    var allCount = useMemo(function () {
      return projects.reduce(function (s, p) { return s + (p.count || 0); }, 0)
        + (unassignedCount || 0);
    }, [projects, unassignedCount]);

    var tabs = useMemo(function () {
      var sorted = projects.slice().sort(function (a, b) {
        return (b.count || 0) - (a.count || 0) || a.slug.localeCompare(b.slug);
      });
      var list = [{ slug: "all", name: "전체", count: allCount }].concat(sorted);
      if (unassignedCount > 0) list.push({ slug: "_unassigned", name: "_unassigned", count: unassignedCount });
      return list;
    }, [projects, unassignedCount, allCount]);

    if (loading) {
      return h("div", { className: "art-topbar" },
        h("div", { className: "art-skeleton",
          style: { width: "80px", height: "20px", margin: "10px 14px", borderRadius: "4px" } })
      );
    }

    return h("div", { className: "art-topbar", role: "tablist", "aria-label": "프로젝트" },
      tabs.map(function (tab) {
        var isActive = tab.slug === activeProject;
        return h("div", {
          key: tab.slug,
          className: "art-tab" + (isActive ? " active" : ""),
          role: "tab",
          "aria-selected": isActive,
          tabIndex: isActive ? 0 : -1,
          onClick: function () { onSelect(tab.slug); },
        },
          tab.name || tab.slug,
          h("span", { className: "art-count" }, tab.count != null ? tab.count : "")
        );
      })
    );
  }

  // ── FilterBar component ────────────────────────────────────────────────────

  function FilterBar(props) {
    var source   = props.source;
    var kind     = props.kind;
    var q        = props.q;
    var count    = props.count;
    var onSource = props.onSource;
    var onKind   = props.onKind;
    var onQ      = props.onQ;

    var _iv = useState(q);
    var inputVal = _iv[0]; var setInputVal = _iv[1];
    var timerRef = useRef(null);

    // Keep local input in sync when parent resets q (e.g. after 422)
    useEffect(function () { setInputVal(q); }, [q]);

    function handleInput(e) {
      var val = e.target.value.slice(0, 100);
      setInputVal(val);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(function () { onQ(val); }, 400);
    }

    function FilterGroup(label, value, opts, onChange) {
      return h("div", { className: "art-filter-group", role: "group", "aria-label": label },
        opts.map(function (opt, i) {
          return [
            i > 0 && h("div", { key: "sep" + i, className: "art-filter-sep" }),
            h("button", {
              key: opt,
              className: "art-filter-btn" + (value === opt ? " active" : ""),
              onClick: function () { onChange(opt); },
            }, opt === "all" ? "All" : opt)
          ];
        })
      );
    }

    return h("div", { className: "art-filterbar" },
      FilterGroup("Source", source, ["all", "staging", "kanban", "reports"], onSource),
      FilterGroup("Kind",   kind,   ["all", "image",   "doc",    "text",    "other"], onKind),
      h("div", { className: "art-search-wrap" },
        h("span", { className: "art-search-icon" }, "🔍"),
        h("input", {
          className: "art-search-input",
          type: "search",
          placeholder: "파일명 검색…",
          "aria-label": "파일명 검색",
          value: inputVal,
          onChange: handleInput,
        })
      ),
      h("span", { className: "art-result-count", "aria-live": "polite" },
        count != null ? count.toLocaleString() + "개 항목" : ""
      )
    );
  }

  // ── ListPane component ─────────────────────────────────────────────────────

  function ListPane(props) {
    var items          = props.items;
    var compareIds     = props.compareIds;
    var selectedItem   = props.selectedItem;
    var loading        = props.loading;
    var loadingMore    = props.loadingMore;
    var truncated      = props.truncated;
    var count          = props.count;
    var collapsed      = props.collapsed;
    var onSelect       = props.onSelect;
    var onToggleCompare = props.onToggleCompare;
    var sentinelRef    = props.sentinelRef;

    var compareSet = useMemo(function () {
      var s = {};
      compareIds.forEach(function (id) { s[id] = true; });
      return s;
    }, [compareIds]);

    function renderList() {
      if (loading && items.length === 0) {
        return Array.from({ length: 6 }, function (_, i) {
          return h(SkeletonRow, { key: "sk" + i });
        });
      }

      if (!loading && items.length === 0) {
        return [h("div", { key: "empty", className: "art-empty-list" },
          h("span", { style: { fontSize: "32px", opacity: 0.3 } }, "🗂"),
          h("p", { className: "art-empty-title" }, "산출물 없음")
        )];
      }

      var rows = [];
      var currentGroup = undefined;

      items.forEach(function (item) {
        if (item.group !== undefined && item.group !== null && item.group !== currentGroup) {
          currentGroup = item.group;
          rows.push(h("div", { key: "g-" + currentGroup, className: "art-group-header" }, currentGroup));
        }
        rows.push(h(FileRow, {
          key: item.id,
          item: item,
          isSelected: !!(selectedItem && selectedItem.id === item.id),
          isCompared: !!compareSet[item.id],
          onSelect: onSelect,
          onToggleCompare: onToggleCompare,
        }));
      });

      if (truncated && count) {
        rows.push(h("div", {
          key: "truncated",
          className: "art-truncated-banner",
          role: "alert",
        }, "⚠ " + count.toLocaleString() + "건 중 일부만 표시. 검색어를 구체화하세요."));
      }

      // IntersectionObserver sentinel
      rows.push(h("div", { key: "sentinel", ref: sentinelRef, style: { height: "1px" } }));

      if (loadingMore) {
        rows.push(h("div", {
          key: "loading-more",
          style: { padding: "12px", textAlign: "center", color: "var(--art-fg-muted)", fontSize: "11px" },
        }, "불러오는 중…"));
      }

      return rows;
    }

    return h("div", {
      className: "art-list-pane" + (collapsed ? " collapsed" : ""),
      role: "region",
      "aria-label": "파일 목록",
    },
      h("div", { className: "art-list-pane-header" },
        h("span", { className: "art-list-pane-label" }, "파일 목록"),
        compareIds.length > 0 && h("span", { className: "art-compare-count-badge" },
          compareIds.length + " 선택"
        )
      ),
      h("div", {
        className: "art-list-scroll",
        role: "listbox",
        "aria-label": "파일 선택",
        "aria-multiselectable": "true",
      }, renderList())
    );
  }

  // ── PreviewPane component ──────────────────────────────────────────────────
  //
  // B2a: meta header only.
  // B2b: replace the placeholder in preview-body with actual renderers.

  function PreviewPane(props) {
    var selectedItem  = props.selectedItem;
    var compareItems  = props.compareItems;
    var onMobileBack  = props.onMobileBack;
    var onDownload    = props.onDownload;
    var isMobileVisible = props.isMobileVisible;

    var isEmpty     = !selectedItem;
    var isComparing = compareItems && compareItems.length >= 2;

    var cls = "art-preview-pane" + (isMobileVisible ? " mobile-visible" : "");

    function Header() {
      if (isEmpty) return null;
      return h("div", { className: "art-preview-header" },
        h("button", {
          className: "art-mobile-back-btn",
          onClick: onMobileBack,
          "aria-label": "목록으로 돌아가기",
        }, "← 목록"),
        h("span", { className: "art-preview-filename", title: selectedItem.name },
          selectedItem.name
        ),
        h("div", { className: "art-preview-meta-row" },
          h("span", null, fmtSize(selectedItem.size)),
          h("span", null, "·"),
          h("span", null, timeAgo(selectedItem.mtime)),
          selectedItem.task && h("a", {
            className: "art-kanban-link",
            href: "#",
            "aria-label": "칸반 카드로 이동",
            onClick: function (e) {
              e.preventDefault();
              try {
                localStorage.setItem("hermes.kanban.selectedTask", selectedItem.task.id);
              } catch (_) {}
              // Navigate to kanban tab — set hash to trigger SPA routing
              window.location.hash = "/kanban";
            },
          }, "🔗 ", selectedItem.task.id)
        ),
        h("button", {
          className: "art-download-btn",
          disabled: !!selectedItem.orphan,
          onClick: function () { onDownload(selectedItem.id, selectedItem.name); },
        }, "↓ 다운로드")
      );
    }

    function Body() {
      if (isEmpty) {
        return h("div", { className: "art-empty-preview" },
          h("span", { className: "art-empty-icon" }, "👈"),
          h("p", null, "왼쪽 목록에서 파일을 선택하세요")
        );
      }
      if (isComparing) {
        return h("div", { className: "art-compare-placeholder" },
          h("span", { style: { fontSize: "32px", opacity: 0.4 } }, "⊞"),
          h("p", null, compareItems.length + "개 선택 — 비교뷰는 B2c에서 구현됩니다")
        );
      }
      // Single item — B2b renders actual content here.
      return h("div", { className: "art-preview-b2b-placeholder" },
        h("span", { style: { fontSize: "40px", opacity: 0.2 } }, kindEmoji(selectedItem.kind)),
        h("p", { style: { fontSize: "13px", marginTop: "8px" } }, selectedItem.name),
        h("p", { style: { fontSize: "11px", color: "var(--art-fg-muted)", marginTop: "4px" } },
          "미리보기 구현 중 (B2b)"
        )
      );
    }

    return h("div", { className: cls, role: "region", "aria-label": "파일 미리보기" },
      Header(),
      h("div", { className: "art-preview-body" }, Body())
    );
  }

  // ── CompareStrip component ─────────────────────────────────────────────────

  function CompareStrip(props) {
    var compareItems = props.compareItems;
    var onRemove     = props.onRemove;
    var onClear      = props.onClear;

    if (!compareItems || compareItems.length < 2) return null;

    return h("div", {
      className: "art-compare-strip",
      role: "region",
      "aria-label": "비교뷰 트레이",
    },
      h("span", { className: "art-strip-label" }, "비교:"),
      compareItems.map(function (item) {
        var label = item.name.length > 20 ? item.name.slice(0, 18) + "…" : item.name;
        return h("div", { key: item.id, className: "art-compare-chip" },
          kindEmoji(item.kind), " ", label,
          h("span", {
            className: "art-chip-x",
            onClick: function () { onRemove(item.id); },
            "aria-label": "비교 해제",
            tabIndex: 0,
            role: "button",
          }, "×")
        );
      }),
      h("div", { className: "art-spacer" }),
      h("button", { className: "art-clear-compare-btn", onClick: onClear }, "전체 해제")
    );
  }

  // ── ArtifactsApp root ──────────────────────────────────────────────────────

  function ArtifactsApp() {
    // ── Projects
    var _p = useState([]);    var projects = _p[0]; var setProjects = _p[1];
    var _uc = useState(0);    var unassignedCount = _uc[0]; var setUnassignedCount = _uc[1];
    var _lp = useState(true); var loadingProjects = _lp[0]; var setLoadingProjects = _lp[1];
    var _pe = useState(null); var projectsError = _pe[0]; var setProjectsError = _pe[1];

    // ── Filters
    var _ap = useState("all"); var activeProject = _ap[0]; var setActiveProject = _ap[1];
    var _src = useState("all"); var source = _src[0]; var setSource = _src[1];
    var _kd = useState("all"); var kind = _kd[0]; var setKind = _kd[1];
    var _q = useState(""); var q = _q[0]; var setQ = _q[1];

    // ── Items
    var _it = useState([]);    var items = _it[0]; var setItems = _it[1];
    var _nc = useState(null);  var nextCursor = _nc[0]; var setNextCursor = _nc[1];
    var _tr = useState(false); var truncated = _tr[0]; var setTruncated = _tr[1];
    var _cnt = useState(null); var count = _cnt[0]; var setCount = _cnt[1];
    var _li = useState(false); var loadingItems = _li[0]; var setLoadingItems = _li[1];
    var _lm = useState(false); var loadingMore = _lm[0]; var setLoadingMore = _lm[1];
    var _ie = useState(null);  var itemsError = _ie[0]; var setItemsError = _ie[1];

    // ── Selection / compare
    var _si = useState(null);  var selectedItem = _si[0]; var setSelectedItem = _si[1];
    var _cids = useState([]); var compareIds = _cids[0]; var setCompareIds = _cids[1];

    // ── UI state
    var _lc = useState(false); var listCollapsed = _lc[0]; var setListCollapsed = _lc[1];
    var _toast = useState(null); var toast = _toast[0]; var setToast = _toast[1];
    var _mvp = useState(false);  var mobilePreview = _mvp[0]; var setMobilePreview = _mvp[1];
    var _sw = useState(false);   var scanWarnShown = _sw[0]; var setScanWarnShown = _sw[1];

    var sentinelRef   = useRef(null);
    var abortCtrlRef  = useRef(null);
    var loadingMoreRef = useRef(false);
    var nextCursorRef = useRef(null);

    // Keep refs in sync for IntersectionObserver (avoids stale closures)
    useEffect(function () { nextCursorRef.current = nextCursor; }, [nextCursor]);
    useEffect(function () { loadingMoreRef.current = loadingMore; }, [loadingMore]);

    function showToast(msg) { setToast(msg); }

    // ── Fetch projects once on mount ─────────────────────────────────────────
    useEffect(function () {
      setLoadingProjects(true);
      fetchProjects()
        .then(function (data) {
          setProjects(data.projects || []);
          setUnassignedCount(data.unassigned_count || 0);
          setProjectsError(null);
        })
        .catch(function (e) { setProjectsError(e.message || "오류"); })
        .then(function ()   { setLoadingProjects(false); });
    }, []);

    // ── Fetch items (reset on filter change) ─────────────────────────────────
    var loadItemsRef = useRef(null);
    function loadItems(params) {
      if (abortCtrlRef.current) {
        try { abortCtrlRef.current.abort(); } catch (_) {}
      }
      var ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
      abortCtrlRef.current = ac;

      setLoadingItems(true);
      setItemsError(null);
      setItems([]);
      setNextCursor(null);
      setTruncated(false);
      setCount(null);

      fetchItems(Object.assign({}, params, { cursor: "" }))
        .then(function (data) {
          if (ac && ac.signal && ac.signal.aborted) return;
          setItems(data.items || []);
          setNextCursor(data.next_cursor || null);
          setTruncated(!!data.truncated);
          setCount(data.count != null ? data.count : null);
          if (data.scan_ms > 2000 && !scanWarnShown) {
            setScanWarnShown(true);
            showToast("인덱스 갱신 중…");
          }
        })
        .catch(function (e) {
          if (ac && ac.signal && ac.signal.aborted) return;
          if (e.status === 422) {
            showToast("올바르지 않은 필터 값입니다. 초기화합니다.");
            setSource("all"); setKind("all"); setQ("");
          } else {
            setItemsError(e.message || "항목 로드 실패");
          }
        })
        .then(function () {
          if (ac && ac.signal && ac.signal.aborted) return;
          setLoadingItems(false);
        });
    }
    loadItemsRef.current = loadItems;

    useEffect(function () {
      loadItemsRef.current({ project: activeProject, source: source, kind: kind, q: q });
    }, [activeProject, source, kind, q]);

    // ── Cursor pagination (IntersectionObserver) ─────────────────────────────
    useEffect(function () {
      var el = sentinelRef.current;
      if (!el) return;
      var observer = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        var cursor = nextCursorRef.current;
        if (!cursor || loadingMoreRef.current) return;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        fetchItems({
          project: activeProject,
          source: source,
          kind: kind,
          q: q,
          cursor: cursor,
        }).then(function (data) {
          setItems(function (prev) { return prev.concat(data.items || []); });
          setNextCursor(data.next_cursor || null);
          setTruncated(!!data.truncated);
          setCount(data.count != null ? data.count : null);
        }).catch(function (e) {
          if (e.status !== 422) showToast("추가 항목 로드 실패");
        }).then(function () {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        });
      }, { threshold: 0.1 });
      observer.observe(el);
      return function () { observer.disconnect(); };
    }, [activeProject, source, kind, q]);
    // NOTE: nextCursor & loadingMore are read from refs inside the observer.

    // ── Keyboard navigation in file list ────────────────────────────────────
    useEffect(function () {
      function handleKeyDown(e) {
        var rows = Array.from(document.querySelectorAll(".art-file-row"));
        if (rows.length === 0) return;
        var focused = document.activeElement;
        var idx = rows.indexOf(focused);
        if (idx === -1) return;
        if (e.key === "ArrowDown" && idx < rows.length - 1) {
          e.preventDefault();
          rows[idx + 1].focus();
        } else if (e.key === "ArrowUp" && idx > 0) {
          e.preventDefault();
          rows[idx - 1].focus();
        }
      }
      document.addEventListener("keydown", handleKeyDown);
      return function () { document.removeEventListener("keydown", handleKeyDown); };
    }, []);

    // ── Handlers ─────────────────────────────────────────────────────────────

    function handleSelect(item) {
      if (item.orphan) return;
      setSelectedItem(item);
      if (window.innerWidth <= 430) setMobilePreview(true);
    }

    function handleToggleCompare(item) {
      if (item.orphan) return;
      setCompareIds(function (prev) {
        var idx = prev.indexOf(item.id);
        if (idx !== -1) return prev.filter(function (id) { return id !== item.id; });
        if (prev.length >= 4) { showToast("최대 4개까지 비교할 수 있습니다."); return prev; }
        return prev.concat([item.id]);
      });
    }

    function handleRemoveCompare(id) {
      setCompareIds(function (prev) { return prev.filter(function (x) { return x !== id; }); });
    }

    function handleClearCompare() { setCompareIds([]); }

    function handleDownload(id, name) {
      triggerDownload(id, name).then(function (ok) {
        if (!ok) showToast("다운로드 실패");
      });
    }

    function handleRetryItems() {
      loadItemsRef.current({ project: activeProject, source: source, kind: kind, q: q });
    }

    // ── Derived ──────────────────────────────────────────────────────────────

    var compareItems = useMemo(function () {
      return compareIds.map(function (id) {
        return items.find(function (it) { return it.id === id; });
      }).filter(Boolean);
    }, [compareIds, items]);

    var collapseLeft  = listCollapsed ? "36px" : "calc(var(--art-list-pane-w) - 1px)";

    // ── Error page ────────────────────────────────────────────────────────────
    if (projectsError) {
      return h("div", { className: "art-shell" },
        h("div", { className: "art-error-page" },
          h("span", { style: { fontSize: "36px" } }, "⚠"),
          h("p", null, "서버 오류: " + projectsError),
          h("button", { onClick: function () { window.location.reload(); } }, "페이지 새로고침")
        )
      );
    }

    // ── Main render ───────────────────────────────────────────────────────────
    return h("div", { className: "art-shell" },
      h(TopBar, {
        projects: projects,
        unassignedCount: unassignedCount,
        activeProject: activeProject,
        loading: loadingProjects,
        onSelect: function (slug) { setActiveProject(slug); },
      }),
      h(FilterBar, {
        source: source,
        kind: kind,
        q: q,
        count: count,
        onSource: function (s) { setSource(s); },
        onKind:   function (k) { setKind(k); },
        onQ:      function (v) { setQ(v); },
      }),
      h("div", { className: "art-content-area" },
        // Collapse toggle
        h("div", {
          className: "art-pane-collapse-btn",
          role: "button",
          tabIndex: 0,
          "aria-label": listCollapsed ? "목록 펼치기" : "목록 숨기기",
          style: { left: collapseLeft },
          onClick: function () { setListCollapsed(function (c) { return !c; }); },
          onKeyDown: function (e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setListCollapsed(function (c) { return !c; });
            }
          },
        }, listCollapsed ? "›" : "‹"),
        // List pane
        h("div", {
          className: "art-list-pane" + (listCollapsed ? " collapsed" : "") + (mobilePreview ? " mobile-hidden" : ""),
          role: "region",
          "aria-label": "파일 목록",
        },
          h("div", { className: "art-list-pane-header" },
            h("span", { className: "art-list-pane-label" }, "파일 목록"),
            compareIds.length > 0 && h("span", { className: "art-compare-count-badge" },
              compareIds.length + " 선택"
            )
          ),
          h("div", {
            className: "art-list-scroll",
            role: "listbox",
            "aria-label": "파일 선택",
            "aria-multiselectable": "true",
          },
            (function () {
              var content = [];
              if (loadingItems && items.length === 0) {
                content = Array.from({ length: 6 }, function (_, i) {
                  return h(SkeletonRow, { key: "sk" + i });
                });
              } else if (!loadingItems && items.length === 0) {
                content = [h("div", { key: "empty", className: "art-empty-list" },
                  h("span", { style: { fontSize: "32px", opacity: 0.3 } }, "🗂"),
                  h("p", { className: "art-empty-title" }, "산출물 없음")
                )];
              } else {
                var rows = [];
                var curGroup = undefined;
                items.forEach(function (item) {
                  if (item.group != null && item.group !== curGroup) {
                    curGroup = item.group;
                    rows.push(h("div", { key: "g-" + curGroup, className: "art-group-header" }, curGroup));
                  }
                  var isSelected = !!(selectedItem && selectedItem.id === item.id);
                  var isCompared = compareIds.indexOf(item.id) !== -1;
                  rows.push(h(FileRow, {
                    key: item.id,
                    item: item,
                    isSelected: isSelected,
                    isCompared: isCompared,
                    onSelect: handleSelect,
                    onToggleCompare: handleToggleCompare,
                  }));
                });
                if (truncated && count) {
                  rows.push(h("div", { key: "trunc", className: "art-truncated-banner", role: "alert" },
                    "⚠ " + count.toLocaleString() + "건 중 일부만 표시. 검색어를 구체화하세요."
                  ));
                }
                if (loadingMore) {
                  rows.push(h("div", {
                    key: "lm",
                    style: { padding: "12px", textAlign: "center", color: "var(--art-fg-muted)", fontSize: "11px" },
                  }, "불러오는 중…"));
                }
                content = rows;
              }
              // Sentinel은 항상 렌더링: IntersectionObserver가 초기(빈·스켈레톤)
              // 상태부터 감시를 시작해야 cursor 페이징이 동작한다.
              content.push(h("div", { key: "sentinel", ref: sentinelRef, style: { height: "1px" } }));
              return content;
            })()
          )
        ),
        // Preview pane
        h(PreviewPane, {
          selectedItem: selectedItem,
          compareItems: compareItems,
          onMobileBack: function () { setMobilePreview(false); },
          onDownload: handleDownload,
          isMobileVisible: mobilePreview,
        })
      ),
      // Compare strip (≥2 selected)
      compareIds.length >= 2 && h(CompareStrip, {
        compareItems: compareItems,
        onRemove: handleRemoveCompare,
        onClear: handleClearCompare,
      }),
      // Items error bar
      itemsError && h("div", { className: "art-items-error" },
        h("span", null, "⚠ 항목 로드 실패: " + itemsError),
        h("button", { onClick: handleRetryItems }, "다시 시도")
      ),
      // Toast
      toast && h(Toast, { message: toast, onClose: function () { setToast(null); } })
    );
  }

  // ── Register with host plugin system ────────────────────────────────────────
  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("artifacts", ArtifactsApp);
  }

})();

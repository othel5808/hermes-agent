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
    // B2b: svg는 이제 <img>로 미리보기 가능 → 목록 썸네일 ↓only 배지 제거
    var name = (item.name || "").toLowerCase();
    return (
      name.endsWith(".html") || name.endsWith(".htm") ||
      item.kind === "other"
    );
  }

  // ── B2b helpers ─────────────────────────────────────────────────────────────

  function getExt(name) {
    var idx = (name || "").lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
  }

  // classifyPreview — 확장자/kind 기반 렌더러 결정
  function classifyPreview(item) {
    var name = (item.name || "").toLowerCase();
    var ext  = getExt(name);
    var imgExts = ["png","jpg","jpeg","gif","webp","bmp","tiff","avif"];
    if (imgExts.indexOf(ext) !== -1 || item.kind === "image") return "image";
    if (ext === "svg")                          return "svg";
    if (ext === "md" || ext === "markdown")     return "md";
    var textExts = [
      "txt","csv","log","json","yaml","yml","xml","ini","toml","conf",
      "sh","bash","py","js","ts","tsx","jsx","mjs","cjs",
      "rb","go","rs","c","cpp","h","java","kt","swift"
    ];
    if (textExts.indexOf(ext) !== -1)           return "text";
    if (ext === "pdf")                          return "pdf";
    return "no-preview"; // html/htm 및 그 외
  }

  /**
   * makeSvgImgUrl — SVG 안전 렌더러 (Codex 리뷰 대상)
   *
   * 보안 제약 (절대 변경 금지):
   *   1. rawBlob 을 반드시 'image/svg+xml' type 으로 새 Blob 재생성 후
   *      URL.createObjectURL 만 사용한다.
   *   2. 반환된 URL 은 오직 <img src> 에만 사용.
   *      <object> / <iframe> / inline 삽입 / 새 탭 열기 / href 노출 금지.
   *   3. unmount 시 URL.revokeObjectURL 필수 호출 (호출자 책임).
   *   4. <img> 컨텍스트에서는 SVG 내 <script> 와 외부 리소스가 실행되지 않는다.
   *      (브라우저 보안 모델 — 추가 CSP 없이도 적용됨)
   */
  function makeSvgImgUrl(rawBlob) {
    var svgBlob = new Blob([rawBlob], { type: "image/svg+xml" });
    return URL.createObjectURL(svgBlob);
  }

  // fetchContent — authedFetch + 404 1회 refetch 공통 패턴
  // onSuccess(responseOrText), onError(err), asText=true 면 r.text() 반환
  function fetchContent(item, asText, onSuccess, onError) {
    var localUrl = null; // caller uses only for blob; text path ignores
    function tryFetch(id, retry) {
      apiFetch("/content/" + id)
        .then(function (r) {
          if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status });
          return asText ? r.text() : r.blob();
        })
        .then(onSuccess)
        .catch(function (err) {
          if (err.status !== 404 || retry) { onError(err); return; }
          // kind 필터 전달: 루트 간 동일 rel_path 오선택 방지.
          // _make_id sha256 결정적 ID → 서버 재시작 후에도 동일 ID 반환.
          // ID 동일 여부 무관하게 목록 재조회 성공 시 content 1회 재시도.
          refetchItem(item, { kind: item.kind }).then(function (refreshed) {
            if (!refreshed) { onError(err); return; }
            tryFetch(refreshed.id, true);
          }).catch(function () { onError(err); });
        });
    }
    tryFetch(item.id, false);
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

  // Requery an item by name+group (for 404 cache-miss recovery; used by B2b).
  // API 응답에 rel_path 가 없으므로 name + group 조합으로 항목을 식별한다.
  // 같은 group 내에 동일한 name 이 두 개 존재할 수 없으므로 안전하다.
  // 서버 재시작 후 스캔 → 캐시 복구 → content 재요청까지 처리한다.
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
        // name + group 으로 식별: rel_path 는 API 응답에 없으므로 사용 불가.
        return (data.items || []).find(function (i) {
          return i.name === item.name && i.group === item.group;
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
          // kind 필터 전달: 루트 간 동일 rel_path 오선택 방지.
          // ID 동일 여부 무관하게 목록 재조회 성공 시 content 1회 재시도.
          refetchItem(item, { kind: item.kind }).then(function (refreshed) {
            if (!mountedRef.current) return;
            if (!refreshed) { setFailed(true); return; }
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

  // ── B2b: Markdown parser ───────────────────────────────────────────────────
  // 경량 라인 파싱 렌더러: 헤더·목록·코드블록·굵게·http(s) 링크만 지원.
  // 표·이미지 미지원. innerHTML 미사용 — React textContent 처리로 XSS 안전.

  function parseMd(text) {
    var lines = text.split("\n");
    var elements = [];
    var i = 0;
    var k = 0;
    function key() { return "md" + (k++); }

    function parseInline(s) {
      var parts = [];
      var re = /(\*\*([^*\n]+?)\*\*|`([^`\n]+?)`|(https?:\/\/[^\s<>"()]*[^\s<>"().,!?;:]))/g;
      var last = 0, m, ki = 0;
      while ((m = re.exec(s)) !== null) {
        if (m.index > last) parts.push(s.slice(last, m.index));
        if (m[2] !== undefined)      parts.push(h("strong", { key: "b"+ki++ }, m[2]));
        else if (m[3] !== undefined) parts.push(h("code",   { key: "c"+ki++ }, m[3]));
        else if (m[4] !== undefined) parts.push(h("a", { key: "a"+ki++, href: m[4], target: "_blank", rel: "noopener noreferrer" }, m[4]));
        last = m.index + m[0].length;
      }
      if (last < s.length) parts.push(s.slice(last));
      return parts;
    }

    while (i < lines.length) {
      var line = lines[i];
      // 코드블록
      if (line.startsWith("```")) {
        var lang = line.slice(3).trim();
        var code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
        elements.push(h("pre", { key: key(), className: "art-md-pre" },
          h("code", { className: lang ? "lang-"+lang : "" }, code.join("\n"))
        ));
        i++; continue;
      }
      // 헤더
      var hm = line.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        var lvl = hm[1].length;
        elements.push(h("h"+Math.min(lvl,6), { key: key(), className: "art-md-h"+lvl }, parseInline(hm[2])));
        i++; continue;
      }
      // 순서없는 목록
      if (/^[\-\*]\s+/.test(line)) {
        var lis = [];
        while (i < lines.length && /^[\-\*]\s+/.test(lines[i])) {
          lis.push(h("li", { key: i }, parseInline(lines[i].replace(/^[\-\*]\s+/, ""))));
          i++;
        }
        elements.push(h("ul", { key: key(), className: "art-md-ul" }, lis));
        continue;
      }
      // 수평선
      if (/^---+$/.test(line.trim())) {
        elements.push(h("hr", { key: key(), className: "art-md-hr" }));
        i++; continue;
      }
      // 빈 줄
      if (line.trim() === "") { i++; continue; }
      // 단락
      elements.push(h("p", { key: key(), className: "art-md-p" }, parseInline(line)));
      i++;
    }
    return elements;
  }

  // ── B2b: ImageRenderer (png/jpg/gif/webp + svg via makeSvgImgUrl) ──────────

  function ImageRenderer(props) {
    var item    = props.item;
    var items   = props.items || [];
    var onSelect = props.onSelect;
    var isSvg  = props.isSvg;

    var mountedRef = useRef(true);
    var _url  = useState(null);  var blobUrl = _url[0];  var setBlobUrl = _url[1];
    var _err  = useState(false); var loadErr = _err[0];  var setLoadErr = _err[1];
    var _zoom = useState(false); var zoomed  = _zoom[0]; var setZoomed  = _zoom[1];

    // 이미지/SVG 항목만 ←/→ 이동 대상
    var navItems = useMemo(function () {
      return items.filter(function (it) {
        var p = classifyPreview(it);
        return p === "image" || p === "svg";
      });
    }, [items]);
    var curIdx = useMemo(function () {
      return navItems.findIndex(function (it) { return it.id === item.id; });
    }, [navItems, item.id]);

    useEffect(function () {
      mountedRef.current = true;
      setBlobUrl(null); setLoadErr(false); setZoomed(false);
      var localUrl = null;
      fetchContent(item, false,
        function (blob) {
          if (!mountedRef.current) return;
          // SVG는 makeSvgImgUrl로 격리: image/svg+xml Blob → <img> 전용
          localUrl = isSvg ? makeSvgImgUrl(blob) : URL.createObjectURL(blob);
          setBlobUrl(localUrl);
        },
        function () { if (mountedRef.current) setLoadErr(true); }
      );
      return function () {
        mountedRef.current = false;
        if (localUrl) URL.revokeObjectURL(localUrl);
      };
    }, [item.id, isSvg]);

    function goPrev() { if (curIdx > 0 && onSelect) onSelect(navItems[curIdx - 1]); }
    function goNext() { if (curIdx < navItems.length - 1 && onSelect) onSelect(navItems[curIdx + 1]); }

    if (loadErr) return h("div", { className: "art-preview-err" },
      h("span", { style: { fontSize: "28px", opacity: 0.3 } }, "⚠"),
      h("p", null, "이미지를 불러올 수 없습니다")
    );

    return h("div", { className: "art-img-viewer" },
      curIdx > 0 && h("button", {
        className: "art-img-nav-btn art-img-nav-prev",
        onClick: goPrev, "aria-label": "이전 이미지",
      }, "‹"),
      curIdx < navItems.length - 1 && h("button", {
        className: "art-img-nav-btn art-img-nav-next",
        onClick: goNext, "aria-label": "다음 이미지",
      }, "›"),
      !blobUrl
        ? h("div", { className: "art-img-loading" },
            h("div", { className: "art-skeleton", style: { width: "80px", height: "80px", borderRadius: "8px" } })
          )
        : h("img", {
            className: "art-preview-img" + (zoomed ? " zoomed" : ""),
            src: blobUrl,
            alt: item.name,
            onClick: function () { setZoomed(function (z) { return !z; }); },
            title: zoomed ? "클릭하여 축소" : "클릭하여 확대",
          })
    );
  }

  // ── B2b: MdRenderer ────────────────────────────────────────────────────────

  function MdRenderer(props) {
    var item = props.item;
    var mountedRef = useRef(true);
    var _txt = useState(null);  var text    = _txt[0]; var setText    = _txt[1];
    var _err = useState(false); var loadErr = _err[0]; var setLoadErr = _err[1];

    useEffect(function () {
      mountedRef.current = true;
      setText(null); setLoadErr(false);
      fetchContent(item, true,
        function (t) { if (mountedRef.current) setText(t); },
        function () { if (mountedRef.current) setLoadErr(true); }
      );
      return function () { mountedRef.current = false; };
    }, [item.id]);

    if (loadErr) return h("div", { className: "art-preview-err" }, "마크다운을 불러올 수 없습니다");
    if (text === null) return h("div", { className: "art-text-loading" }, "불러오는 중…");
    return h("div", { className: "art-md-content" }, parseMd(text));
  }

  // ── B2b: TextRenderer ──────────────────────────────────────────────────────
  // txt/csv/log/json/yaml 등: <pre>에 raw text — React textContent → XSS 안전

  function TextRenderer(props) {
    var item = props.item;
    var mountedRef = useRef(true);
    var _txt = useState(null);  var text    = _txt[0]; var setText    = _txt[1];
    var _err = useState(false); var loadErr = _err[0]; var setLoadErr = _err[1];

    useEffect(function () {
      mountedRef.current = true;
      setText(null); setLoadErr(false);
      fetchContent(item, true,
        function (t) { if (mountedRef.current) setText(t); },
        function () { if (mountedRef.current) setLoadErr(true); }
      );
      return function () { mountedRef.current = false; };
    }, [item.id]);

    if (loadErr) return h("div", { className: "art-preview-err" }, "파일을 불러올 수 없습니다");
    if (text === null) return h("div", { className: "art-text-loading" }, "불러오는 중…");
    return h("pre", { className: "art-text-content" }, text);
  }

  // ── B2b: PdfRenderer ───────────────────────────────────────────────────────

  function PdfRenderer(props) {
    var item = props.item;
    var mountedRef = useRef(true);
    var _url  = useState(null);  var blobUrl = _url[0];  var setBlobUrl = _url[1];
    var _err  = useState(false); var loadErr = _err[0];  var setLoadErr = _err[1];

    useEffect(function () {
      mountedRef.current = true;
      setBlobUrl(null); setLoadErr(false);
      var localUrl = null;
      fetchContent(item, false,
        function (blob) {
          if (!mountedRef.current) return;
          localUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
          setBlobUrl(localUrl);
        },
        function () { if (mountedRef.current) setLoadErr(true); }
      );
      return function () {
        mountedRef.current = false;
        if (localUrl) URL.revokeObjectURL(localUrl);
      };
    }, [item.id]);

    if (loadErr) return h("div", { className: "art-preview-err" }, "PDF를 불러올 수 없습니다");
    if (!blobUrl) return h("div", { className: "art-text-loading" }, "PDF 불러오는 중…");
    return h("iframe", {
      className: "art-pdf-frame",
      src: blobUrl,
      title: item.name,
      // allow-scripts: 브라우저 내장 PDF 뷰어 플러그인에 필요.
      // blob: origin이므로 외부 스크립트 접근 불가.
      sandbox: "allow-scripts allow-same-origin",
    });
  }

  // ── B2b: NoPreviewRenderer (html/htm 및 그 외) ─────────────────────────────

  function NoPreviewRenderer(props) {
    var item       = props.item;
    var onDownload = props.onDownload;
    return h("div", { className: "art-no-preview" },
      h("span", { className: "art-no-preview-icon" }, "📄"),
      h("p",    { className: "art-no-preview-text" }, "미리보기 불가 · 다운로드 전용"),
      h("p",    { className: "art-no-preview-sub"  }, item.name),
      h("button", {
        className: "art-download-btn",
        style: { marginTop: "8px" },
        disabled: !!item.orphan,
        onClick: function () { onDownload(item.id, item.name); },
      }, "↓ 다운로드")
    );
  }

  // ── B2c: CompareMiniImage ──────────────────────────────────────────────────
  // 비교 grid 셀용 경량 이미지 로더.  blob revoke = unmount 시 자동.

  function CompareMiniImage(props) {
    var item   = props.item;
    var isSvg  = props.isSvg;

    var mountedRef = useRef(true);
    var _url = useState(null);  var blobUrl = _url[0];  var setBlobUrl = _url[1];
    var _err = useState(false); var loadErr = _err[0];  var setLoadErr = _err[1];

    useEffect(function () {
      mountedRef.current = true;
      setBlobUrl(null); setLoadErr(false);
      var localUrl = null;
      fetchContent(item, false,
        function (blob) {
          if (!mountedRef.current) return;
          localUrl = isSvg ? makeSvgImgUrl(blob) : URL.createObjectURL(blob);
          setBlobUrl(localUrl);
        },
        function () { if (mountedRef.current) setLoadErr(true); }
      );
      return function () {
        mountedRef.current = false;
        if (localUrl) URL.revokeObjectURL(localUrl);
      };
    }, [item.id, isSvg]);

    if (loadErr) return h("div", { className: "art-compare-cell-noimg" }, "⚠");
    if (!blobUrl) return h("div", {
      className: "art-compare-cell-loading art-skeleton",
      style: { width: "70%", height: "70%", borderRadius: "6px" },
    });
    return h("img", {
      className: "art-compare-mini-img",
      src: blobUrl,
      alt: item.name,
    });
  }

  // ── B2c: CompareGrid ───────────────────────────────────────────────────────
  // 2~4개 선택 시 미리보기 pane을 2-column grid로 전환.
  // 이미지/SVG: CompareMiniImage.  그 외: 종류 아이콘+파일명.

  function CompareGrid(props) {
    var compareItems = props.compareItems; // 2..4 items

    return h("div", { className: "art-compare-grid" },
      compareItems.map(function (item) {
        var preview = classifyPreview(item);
        var isImg   = preview === "image" || preview === "svg";
        return h("div", { key: item.id, className: "art-compare-cell" },
          h("div", { className: "art-compare-cell-head" },
            h("span", { className: srcDotClass(item.source) }),
            h("span", { className: "art-compare-cell-name", title: item.name }, item.name)
          ),
          h("div", { className: "art-compare-cell-body" },
            isImg
              ? h(CompareMiniImage, { item: item, isSvg: preview === "svg" })
              : h("div", { className: "art-compare-cell-nopreview" },
                  h("span", { style: { fontSize: "28px", opacity: 0.25 } }, kindEmoji(item.kind)),
                  h("p", {
                    style: {
                      fontSize: "10px", color: "var(--art-fg-muted)",
                      textAlign: "center", padding: "0 10px",
                      wordBreak: "break-all", marginTop: "6px",
                    },
                  }, item.name)
                )
          )
        );
      })
    );
  }

  // ── PreviewPane component ──────────────────────────────────────────────────
  //
  // B2a: meta header only.
  // B2b: replace the placeholder in preview-body with actual renderers.
  // B2c: compare grid (2~4 items selected).

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
      // B2c: compare mode header — show back button + count title on all viewports.
      // .art-mobile-back-btn is display:none on desktop so it stays invisible there.
      if (isComparing) {
        return h("div", { className: "art-preview-header" },
          h("button", {
            className: "art-mobile-back-btn",
            onClick: onMobileBack,
            "aria-label": "목록으로 돌아가기",
          }, "← 목록"),
          h("span", { className: "art-preview-filename" },
            "⊞ " + compareItems.length + "개 비교"
          )
        );
      }
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
              // B2c: kanban deeplink — set both task ID and board slug before navigating.
              // kanban plugin reads hermes.kanban.selectedTask + hermes.kanban.selectedBoard.
              try {
                localStorage.setItem("hermes.kanban.selectedTask", selectedItem.task.id);
                localStorage.setItem("hermes.kanban.selectedBoard", selectedItem.task.board || "default");
              } catch (_) {}
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
      if (isComparing) {
        // B2c: compare grid (2~4 items) — takes precedence over single-item preview.
        return h(CompareGrid, { compareItems: compareItems });
      }
      if (isEmpty) {
        return h("div", { className: "art-empty-preview" },
          h("span", { className: "art-empty-icon" }, "👈"),
          h("p", null, "왼쪽 목록에서 파일을 선택하세요")
        );
      }
      // B2b: 실제 컨텐츠 렌더러 (classifyPreview로 라우팅)
      var preview = classifyPreview(selectedItem);
      if (preview === "image") return h(ImageRenderer, { item: selectedItem, items: props.items, onSelect: props.onSelectItem, isSvg: false });
      if (preview === "svg")   return h(ImageRenderer, { item: selectedItem, items: props.items, onSelect: props.onSelectItem, isSvg: true });
      if (preview === "md")    return h(MdRenderer,    { item: selectedItem });
      if (preview === "text")  return h(TextRenderer,  { item: selectedItem });
      if (preview === "pdf")   return h(PdfRenderer,   { item: selectedItem });
      return h(NoPreviewRenderer, { item: selectedItem, onDownload: onDownload });
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
    var onViewCompare = props.onViewCompare; // B2c: mobile "⊞ 비교" button

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
      // B2c: mobile-only button — hidden on desktop via CSS
      h("button", {
        className: "art-compare-view-btn",
        onClick: onViewCompare,
        "aria-label": "비교 그리드 보기",
      }, "⊞ 비교"),
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
          // B2b: 이미지 ←/→ 네비게이션용
          items: items,
          onSelectItem: handleSelect,
        })
      ),
      // Compare strip (≥2 selected)
      compareIds.length >= 2 && h(CompareStrip, {
        compareItems: compareItems,
        onRemove: handleRemoveCompare,
        onClear: handleClearCompare,
        onViewCompare: function () { setMobilePreview(true); }, // B2c: mobile
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

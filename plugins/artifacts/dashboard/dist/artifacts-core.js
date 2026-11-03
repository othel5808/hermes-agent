(function (root) {
  "use strict";

  function extFor(item) {
    var name = (item && item.name || "").toLowerCase();
    var dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot + 1) : "";
  }

  function buildItemsQuery(filters) {
    var params = new URLSearchParams();
    var values = filters || {};
    ["project", "source", "q", "kind", "cursor", "limit"].forEach(function (key) {
      var value = values[key];
      if (value !== undefined && value !== null && value !== "" && value !== "all") {
        params.set(key, String(value));
      }
    });
    return "?" + params.toString();
  }

  function buildRefetchQuery(item, filters) {
    var values = filters || {};
    return buildItemsQuery({
      project: values.project,
      source: values.source,
      q: values.q || (item && item.name),
      kind: values.kind || (item && item.kind),
      limit: Math.max(20, Number(values.limit) || 50),
    });
  }

  function sameTask(a, b) {
    var taskA = a && a.task;
    var taskB = b && b.task;
    if (!taskA && !taskB) return true;
    return !!taskA && !!taskB && taskA.id === taskB.id && taskA.board === taskB.board;
  }

  function selectRefetchedItem(candidates, original) {
    var list = Array.isArray(candidates) ? candidates : [];
    var exact = list.find(function (candidate) { return candidate && candidate.id === original.id; });
    if (exact) return exact;
    var matching = list.filter(function (candidate) {
      return candidate && candidate.name === original.name &&
        candidate.source === original.source && candidate.group === original.group &&
        candidate.project === original.project && candidate.kind === original.kind &&
        sameTask(candidate, original);
    });
    return matching.length === 1 ? matching[0] : null;
  }

  function shouldRetryContent(state) {
    return !!(state && state.status === 404 && !state.alreadyRetried && state.refreshedItem);
  }

  function previewKind(item) {
    var ext = extFor(item);
    var images = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "avif"];
    var texts = ["txt", "csv", "log", "json", "yaml", "yml", "xml", "ini", "toml", "conf", "sh", "bash", "py", "js", "ts", "tsx", "jsx", "mjs", "cjs", "rb", "go", "rs", "c", "cpp", "h", "java", "kt", "swift"];
    if (images.indexOf(ext) >= 0 || (item && item.kind === "image")) return "image";
    if (ext === "svg") return "svg-img";
    if (ext === "md" || ext === "markdown") return "markdown";
    if (texts.indexOf(ext) >= 0) return "text";
    return "download";
  }

  function isDownloadOnly(item) {
    return previewKind(item) === "download";
  }

  function badgeForItem(item) {
    return isDownloadOnly(item) ? "download-only" : null;
  }

  var ArtifactsCore = {
    buildItemsQuery: buildItemsQuery,
    buildRefetchQuery: buildRefetchQuery,
    selectRefetchedItem: selectRefetchedItem,
    shouldRetryContent: shouldRetryContent,
    previewKind: previewKind,
    isDownloadOnly: isDownloadOnly,
    badgeForItem: badgeForItem,
  };

  root.ArtifactsCore = ArtifactsCore;
  if (typeof module !== "undefined") module.exports = ArtifactsCore;
})(typeof window !== "undefined" ? window : globalThis);

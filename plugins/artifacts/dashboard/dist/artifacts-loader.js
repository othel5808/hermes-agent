(function () {
  "use strict";

  var current = document.currentScript;
  var base = current && current.src ? current.src.replace(/[^/]+$/, "") : "dist/";
  var coreName = "artifacts-core.js";

  function loadIndex() {
    if (!window.__HERMES_PLUGIN_SDK__ || !window.__HERMES_PLUGINS__) {
      setTimeout(loadIndex, 10);
      return;
    }
    var index = document.createElement("script");
    index.src = base + "index.js";
    index.async = false;
    document.head.appendChild(index);
  }

  var core = document.createElement("script");
  core.src = base + coreName;
  core.async = false;
  core.onload = loadIndex;
  core.onerror = function () { console.error("Failed to load artifacts core"); };
  document.head.appendChild(core);
})();

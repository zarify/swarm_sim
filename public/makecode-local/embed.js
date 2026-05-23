(() => {
  if (window.ksRunnerInit) {
    return;
  }

  const currentScript = document.currentScript;
  const currentScriptUrl =
    currentScript instanceof HTMLScriptElement && typeof currentScript.src === 'string'
      ? currentScript.src
      : new URL('makecode-local/embed.js', window.location.href).toString();
  const localBaseUrl = new URL('./', currentScriptUrl);
  const hostBaseUrl = new URL('../', currentScriptUrl);
  const commitId = 'a6c81800617988b108f669e6f690fe9fe83a083d';

  const pxtConfig = {
    relprefix: localBaseUrl.toString(),
    verprefix: '',
    workerjs: new URL('worker.js', localBaseUrl).toString(),
    tdworkerjs: new URL('tdworker.js', localBaseUrl).toString(),
    monacoworkerjs: new URL('monacoworker.js', localBaseUrl).toString(),
    gifworkerjs: new URL('gifworker.js', localBaseUrl).toString(),
    serviceworkerjs: new URL('serviceworker.js', localBaseUrl).toString(),
    typeScriptWorkerJs: new URL('tsworker.js', localBaseUrl).toString(),
    pxtVersion: '?',
    pxtRelId: commitId,
    pxtCdnUrl: new URL(`cdn.makecode.com/commit/${commitId}/`, hostBaseUrl).toString(),
    commitCdnUrl: new URL(`cdn.makecode.com/commit/${commitId}/`, hostBaseUrl).toString(),
    blobCdnUrl: new URL(`cdn.makecode.com/`, hostBaseUrl).toString(),
    targetUrl: hostBaseUrl.toString().replace(/\/$/, ''),
    targetVersion: '?',
    targetRelId: commitId,
    targetCdnUrl: new URL(`cdn.makecode.com/commit/${commitId}/`, hostBaseUrl).toString(),
    targetId: 'microbit',
    runUrl: new URL('---run', hostBaseUrl).toString(),
    docsUrl: new URL('---docs', hostBaseUrl).toString(),
    multiUrl: new URL('---multi', hostBaseUrl).toString(),
    asseteditorUrl: new URL('---asseteditor', hostBaseUrl).toString(),
    skillmapUrl: new URL('---skillmap', hostBaseUrl).toString(),
    authcodeUrl: new URL('---authcode', hostBaseUrl).toString(),
    multiplayerUrl: new URL('---multiplayer', hostBaseUrl).toString(),
    kioskUrl: new URL('---kiosk', hostBaseUrl).toString(),
    teacherToolUrl: new URL('---eval', hostBaseUrl).toString(),
    partsUrl: new URL('---siminstructions', hostBaseUrl).toString(),
    simUrl: new URL('---simulator', hostBaseUrl).toString(),
    simserviceworkerUrl: new URL('---simserviceworker', hostBaseUrl).toString(),
    simworkerconfigUrl: new URL('---simworkerconfig', hostBaseUrl).toString(),
    cdnUrl: new URL('cdn.makecode.com', hostBaseUrl).toString().replace(/\/$/, ''),
  };

  const scripts = [
    'highlight.pack.js',
    'marked.min.js',
    'jquery.js',
    'semantic.js',
    'target.js',
    'pxtembed.js',
  ].map((filename) => new URL(filename, localBaseUrl).toString());

  let pxtCallbacks = [];

  window.ksRunnerReady = (callback) => {
    if (pxtCallbacks == null) {
      callback();
      return;
    }
    pxtCallbacks.push(callback);
  };

  window.ksRunnerWhenLoaded = () => {
    window.pxt.docs.requireHighlightJs = () => window.hljs;
    window.pxt.setupWebConfig(pxtConfig || window.pxtWebConfig);
    window.pxt.runner.setInitCallbacks(pxtCallbacks);
    pxtCallbacks.push(() => {
      pxtCallbacks = null;
    });
    window.pxt.runner.init();
  };

  for (const src of scripts) {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    document.head.appendChild(script);
  }
})();

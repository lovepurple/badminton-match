/*
 * 位置导航：微信内优先用内置地图（JS-SDK wx.openLocation），
 * 其他环境回退到高德 URI（可唤起高德/系统地图）。
 */
(function (global) {
  const BA = (global.BA = global.BA || {});

  function isWechat() {
    return /micromessenger/i.test(navigator.userAgent);
  }

  function hasCoords(venue) {
    return venue && typeof venue.lat === 'number' && typeof venue.lng === 'number';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.dataset.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('script load failed'));
      document.head.appendChild(el);
    });
  }

  let jssdkPromise = null;

  async function ensureJssdk() {
    if (jssdkPromise) return jssdkPromise;
    jssdkPromise = (async () => {
      if (!isWechat() || !BA.api) return null;
      let cfg;
      try {
        cfg = await BA.api.request(
          '/api/wechat/jssdk?url=' + encodeURIComponent(location.href.split('#')[0]),
          { auth: false }
        );
      } catch (e) {
        return null;
      }
      if (!cfg || !cfg.signature) return null;
      try {
        await loadScript('https://res.wx.qq.com/open/js/jweixin-1.6.0.js');
      } catch (e) {
        return null;
      }
      return await new Promise(resolve => {
        global.wx.config({
          debug: false,
          appId: cfg.appId,
          timestamp: cfg.timestamp,
          nonceStr: cfg.nonceStr,
          signature: cfg.signature,
          jsApiList: ['openLocation']
        });
        global.wx.ready(() => resolve(global.wx));
        global.wx.error(() => resolve(null));
      });
    })();
    return jssdkPromise;
  }

  function amapUrl(venue, nav) {
    const position = venue.lng + ',' + venue.lat;
    const name = encodeURIComponent(venue.name || '球馆');
    if (nav) {
      return (
        'https://uri.amap.com/navigation?to=' + position + ',' + name +
        '&mode=car&coordinate=gaode&callnative=1'
      );
    }
    return (
      'https://uri.amap.com/marker?position=' + position + '&name=' + name +
      '&coordinate=gaode&callnative=1'
    );
  }

  /* 打开位置：微信内优先内置地图，其余走高德 */
  async function openLocation(venue, options) {
    const opts = options || {};
    if (!venue) return { ok: false, reason: 'no-venue' };

    if (hasCoords(venue)) {
      const wx = await ensureJssdk();
      if (wx && wx.openLocation) {
        wx.openLocation({
          latitude: venue.lat,
          longitude: venue.lng,
          name: venue.name || '球馆',
          address: venue.address || '',
          scale: 16
        });
        return { ok: true, via: 'wechat' };
      }
      global.open(amapUrl(venue, opts.nav !== false), '_blank');
      return { ok: true, via: 'amap' };
    }

    if (venue.address) {
      try {
        await navigator.clipboard.writeText(venue.address);
      } catch (e) {
        /* 忽略复制失败 */
      }
      return { ok: true, via: 'address' };
    }
    return { ok: false, reason: 'no-address' };
  }

  BA.nav = { openLocation, isWechat, hasCoords };
})(window);

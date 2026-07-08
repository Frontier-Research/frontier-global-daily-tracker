# assets/vendor

These libraries are **self-hosted** on purpose: it lets the Content-Security-Policy
stay `script-src 'self'` with no third-party host, which is the strongest posture.

The GitHub Action downloads them automatically on its first run. To preview locally
before that, fetch them once yourself:

```bash
curl -fsSL https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js -o echarts.min.js
curl -fsSL https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js -o xlsx.full.min.js
```

Pinned versions: echarts 5.5.1, SheetJS (xlsx) 0.18.5. Bump deliberately, and
re-test, rather than tracking `latest`.

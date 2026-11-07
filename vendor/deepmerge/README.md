# Patched deepmerge

`index.cjs` is the distributed CommonJS file from `deepmerge@4.3.1` (MIT), with a key guard in both merge loops for [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). The local version identifies this patched source. Both Workbox's Rollup resolver and the proxy logger's serializer resolve to this package.

Remove the local package and override once those callers can resolve an upstream fixed release. The installed dependency regression covers both callers and prototype-bearing inputs.

# Third-party notices

`@voxelkloud/wasm-proj` ships a compiled wasm module that statically links
third-party Rust code, so the notices below travel with the published package.

`voxelkloud_wasm_proj_bg.wasm` links, and only links:

| Crate | Version | License |
| --- | --- | --- |
| [proj4rs](https://github.com/3liz/proj4rs) | 0.1.10 | MIT OR Apache-2.0 |
| [crs-definitions](https://github.com/sdruskat/crs-definitions) | 0.4.0 | CC0-1.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.20 | MIT OR Apache-2.0 |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | 0.2.127 | MIT OR Apache-2.0 |
| [js-sys](https://github.com/wasm-bindgen/wasm-bindgen) | 0.3.104 | MIT OR Apache-2.0 |
| [web-sys](https://github.com/wasm-bindgen/wasm-bindgen) | 0.3.104 | MIT OR Apache-2.0 |
| [console_log](https://github.com/iamcodemaker/console_log) | 1.1.0 | MIT OR Apache-2.0 |

Every dual-licensed crate is taken under MIT, which asks only that the notice
below travel with the binary. `crs-definitions` is CC0-1.0 — a dedication to the
public domain, which asks nothing — and it is the EPSG parameter table this
package resolves codes through.

None of them are modified.

## proj4rs

The Rust adaptation of proj4, by 3Liz.

Upstream: https://github.com/3liz/proj4rs

```
Copyright (c) 2023 3Liz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## thiserror, wasm-bindgen, js-sys, web-sys, console_log

Each is offered under MIT or Apache-2.0 and taken here under MIT, whose terms
are reproduced above. Copyright is held by their respective authors: David
Tolnay for `thiserror`, the wasm-bindgen Developers for `wasm-bindgen`,
`js-sys` and `web-sys`, and Matthew Nicholson for `console_log`.

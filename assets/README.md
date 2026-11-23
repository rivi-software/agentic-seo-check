# Brand assets

The RIVI Software identity the README shows, each file for light grounds and `-on-dark` for dark ones:

| File | What | Shown in |
| --- | --- | --- |
| `icon.svg`, `icon-on-dark.svg` | The Agentic SEO Check icon: a search lens with a signal-green four-point AI spark on RIVI Software's rounded tile | The MCP server, the website, PDF reports, share cards, and directories or tools that look for `assets/icon.svg` |
| `rivi-agentic-seo-check.svg`, `rivi-agentic-seo-check-on-dark.svg` | The RIVI Agentic SEO Check lockup: the Agentic SEO Check icon beside the name | The README's header |
| `rivi-mark.svg`, `rivi-mark-on-dark.svg` | The RIVI Software mark: an ink tile with five level bars, the middle one lit in the signal green | The sign-off at the end of the README |

The tile's geometry and colours are RIVI Software's, as [rivi.software](https://rivi.software) draws them; the `rivi-mark` files are copies of the ones in [`rivi-software/tools`](https://github.com/rivi-software/tools/tree/main/assets), and `icon.svg` / `icon-on-dark.svg` reuse the same 40×40 tile (`rx="9"`) and palette for Agentic SEO Check. The lockup is laid out as the `RIVI tools` lockup there is: Bricolage Grotesque ([SIL OFL 1.1](https://github.com/ateliertriay/bricolage)) at weight 600, optical size 20, width 100 and tracked -0.02em, set at 20 px beside a 36 px mark, 10 px apart. The name is drawn as outlines, so the files load no font. The same settings redraw `RIVI tools` and `RIVI Workspace` byte for byte, which is how this one was checked.

Keep these files where they are, under these names. The README is also shown on npm, away from the repository, so it loads them from `main` by their full address (`https://raw.githubusercontent.com/rivi-software/agentic-seo-check/main/assets/…`), and every version already on npm keeps that address.

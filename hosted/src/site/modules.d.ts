/**
 * The fonts of a shared result's image (src/ui/share-image.ts), which wrangler.site.jsonc's rules
 * bundle as their bytes. `wrangler types` declares the modules of wrangler.jsonc's rules only, and
 * the MCP server imports no font file of this kind.
 */
declare module "*.ttf" {
  const value: ArrayBuffer;
  export default value;
}

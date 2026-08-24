# sf-cms-updates-from-salsify

Updates product and category images from a CSV of `identifier,url` pairs. Each
source image is downloaded, uploaded into the CMS as binary media, published,
and linked to the matching product or category.

## Install

```
npm install
```

Requires Node 18 or newer, and the `sf` CLI on PATH with the target org already
authorized:

```
sf org login web --alias <alias>
```

## Usage

```
node update-media.js --org <alias> --workspace <id> --csv <path> \
                     --action swap|add|delete --entity product|category
```

Use `--dry-run` first. It reports every intended change and writes nothing.
Run `node update-media.js --help` for the full list of options.

## CSV

Two columns:

```
identifier,url
ABC123,https://example.com/images/one.jpg
ABC124,https://example.com/images/one.jpg
```

`identifier` is the SKU for `--entity product`, and the category external id for
`--entity category`. Column headings are matched loosely.

An image used by several identifiers is downloaded and uploaded **once**, then
linked to all of them. `--action delete` ignores the `url` column.

## Actions

**`swap`** uploads the new image, publishes it, confirms it is live, then
removes the old links, adds the new ones, and unpublishes the replaced content.
The record is never left without an image part-way through.

**`add`** uploads, publishes and links the new image without removing anything.

**`delete`** removes the image links and unpublishes the content behind them.

`swap` and `delete` unpublish old content **only when nothing else still refers
to it**. Content cannot be deleted through the API; unpublishing is reversible.

## Image groups

`--entity product` covers the listing and detail image groups, and one CSV row
fills both. `--entity category` covers the tile image group. Narrow that with
`--groups`:

```
--groups productListImage       # listing images only
--groups tileImage              # category tiles (--entity may be omitted)
```

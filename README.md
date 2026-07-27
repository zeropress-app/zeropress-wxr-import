# @zeropress/wxr-import

![npm](https://img.shields.io/npm/v/%40zeropress%2Fwxr-import)
![license](https://img.shields.io/npm/l/%40zeropress%2Fwxr-import)
![node](https://img.shields.io/node/v/%40zeropress%2Fwxr-import)

Public ZeroPress WordPress migration CLI for Preview Data v0.7.

This package converts a WordPress WXR 1.2 export into canonical ZeroPress
`preview-data` JSON, plus an editable base file that captures the values WXR
cannot supply.

Public contract references:

- [Preview Data v0.7 Spec](https://zeropress.dev/reference/preview-data/specs/v0.7/)
- [Preview Data v0.7 Schema](https://schemas.zeropress.dev/preview-data/v0.7/schema.json)
- [WXR Import Base v0.7 Schema](https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json)

## Install

```bash
# Run directly with npx
npx @zeropress/wxr-import --help

# Or install globally
npm install -g @zeropress/wxr-import
zeropress-wxr-import --help
```

## Quick Start

Convert a WordPress export into preview-data:

```bash
npx @zeropress/wxr-import --input wordpress-export.xml --output preview-data.json
```

Build a static site from the result with
[@zeropress/build](https://www.npmjs.com/package/@zeropress/build):

```bash
npx @zeropress/build ./theme --data ./preview-data.json --out ./dist
```

## Usage

```bash
zeropress-wxr-import --input <file> --output <file.json> [--base <file>] [--no-report]
```

### Required Options

- `--input <file>`: WordPress WXR XML export file
- `--output <file.json>`: Output preview-data v0.7 JSON file

### Other Options

- `--base <file>`: Optional v0.7 JSON file containing site preset and import settings
- `--no-report`: Do not write `.zeropress-wxr-import/wxr-import-report.json`
- `--help, -h`: Show help
- `--version, -v`: Show version

`--input` and `--output` are required for conversion. `--base` optionally
supplies site presets and import settings; omitting it starts from an empty base.
Running the command without arguments displays the help text and exits with
status 0. Explicit `--help`/`-h` and `--version`/`-v` requests are global and
also exit with status 0 when combined with conversion options; help takes
precedence when both are present. The output filename must use the lowercase
`.json` extension.

## Supported WXR input

The input must satisfy all of the following requirements:

- an `<rss version="2.0">` root;
- exactly one direct `<channel>`;
- the WordPress export namespace `http://wordpress.org/export/1.2/`;
- a direct `wp:wxr_version` value of `1.2`; and
- a direct, valid RFC 2822 `<pubDate>`.

After byte and control-character sanitization, malformed XML, DOCTYPE
declarations, non-WXR XML, and WXR versions other than 1.2 are rejected instead
of producing an empty import. Preview Data
`generated_at` is the WXR channel publication instant normalized to UTC, so
repeated conversion does not depend on the system clock.

### Parsing and sanitization

The importer sanitizes and parses XML as a byte stream. Malformed UTF-8 bytes
and XML-prohibited non-printable ASCII control bytes are removed before strict
XML parsing; an explicitly encoded, valid Unicode replacement character
(`U+FFFD`) is preserved. The importer does not impose a whole-file size limit or
build an XML DOM, although converted preview-data still uses memory proportional
to the retained output. WordPress comments and unknown plugin metadata are not
part of the preview-data contract and are discarded.

## Helper artifacts and write safety

The CLI writes fixed helper artifacts under the current working directory:

- `.zeropress-wxr-import/wxr-import-base.resolved.json`
- `.zeropress-wxr-import/wxr-import-report.json`

Use `--no-report` to skip writing `wxr-import-report.json`. The report path
remains reserved for collision checks, and warnings are still written to
stderr. The resolved base is always written and references the canonical schema:

```json
{
  "$schema": "https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json",
  "version": "0.7"
}
```

`wxr-import-base.resolved.json` is a generated snapshot, not a user-managed
base file. Whenever it is written, an existing file at that path is replaced
without confirmation. The CLI rejects using this artifact directly as
`--base`; copy it to a separate path before editing or reusing it.

Before reading input, the CLI checks canonical paths and existing file
identities. The output cannot alias the input, an optional base, or any helper
artifact. Symlinked helper directories and unsafe write targets are rejected.

Artifacts are first written to exclusive sibling temporary files, flushed, and
then atomically renamed in resolved-base, report, and output order. The primary
output is committed last as the success marker, and uncommitted temporary files
are cleaned after success or failure.

## Base

WXR does not contain every value a ZeroPress site needs. To override inferred
or default values, pass a base JSON file. A provided base must declare
`"version": "0.7"`:

```json
{
  "version": "0.7",
  "site": {
    "title": "Imported Site",
    "description": "",
    "url": "https://example.com",
    "media_origin": "",
    "locale": "en",
    "posts_per_page": 10,
    "date_style": "medium",
    "time_style": "short",
    "timezone": "UTC",
    "robots": { "allow_indexing": true },
    "search": { "enabled": true },
    "feed": { "enabled": true },
    "archive": { "enabled": false },
    "permalinks": {
      "output_style": "html-extension",
      "posts": "/post/:public_id",
      "pages": "/:slug",
      "categories": "/category/:slug",
      "tags": "/tag/:slug"
    }
  },
  "comments": {
    "enabled": true,
    "api_base_url": "https://blog.example/wp-json/wp/v2",
    "provider": "wordpress",
    "per_page": 50,
    "order": "desc",
    "threading": {
      "enabled": true,
      "max_depth": 2
    }
  },
  "custom_css": {
    "content": ".site-title { letter-spacing: -0.02em; }"
  },
  "import": {
    "media_from": "https://example.com/wp-content/uploads/",
    "media_to": "https://media.example.com/imported/"
  }
}
```

The canonical base schema is published at:

```text
https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json
```

To create a reusable base from a conversion, copy the generated snapshot to a
separate file, edit the copy, and pass that file with `--base`:

```bash
cp .zeropress-wxr-import/wxr-import-base.resolved.json ./wxr-import-base.json

npx @zeropress/wxr-import \
  --input wordpress-export.xml \
  --base ./wxr-import-base.json \
  --output preview-data.json
```

Before reading WXR, the importer validates every base value that is copied to
Preview Data against the Preview Data v0.7 contract. This includes nested
favicon, logo, front-page, post-index, footer, metadata, newsletter, widget,
collection, CSS, and HTML shapes. A front-page or collection item's reference
to imported content is structurally checked during this preflight; whether the
referenced Page or Post exists is checked after WXR content has been read.

The importer replaces WXR-owned preview-data sections:

- `content.authors`
- `content.posts`
- `content.pages`
- `content.categories`
- `content.tags`
- `menus`

The required top-level `version` identifies the base contract and must be
exactly `"0.7"`. Do not provide `preview_data`, `content`, `menus`, `generator`,
or `generated_at` in the base; the importer generates them. Other base values
such as `site`, `meta`, `comments`, `newsletter`, `widgets`, `collections`,
`custom_css`, and `custom_html` are preserved. `site` is a closed object, so
unknown properties are rejected. `custom_html` uses trusted raw slot strings
such as `{ "head_end": "<meta ...>", "body_end": "<script ...></script>" }`;
each slot is limited to 65,536 Unicode code points. Top-level `meta`, `comments`,
and `newsletter` become `site.meta`, `site.comments`, and `site.newsletter`,
respectively; their nested `site.*` forms are rejected in the base.

`site.url` is either an empty string or an HTTP(S) origin. Explicit values with
credentials, a path, query, or fragment are rejected; a trailing root slash is
accepted and canonicalized away. When it is omitted, the importer writes only
the origin of the WXR channel link. The original channel URL is retained
separately for WordPress comments API inference, so a WordPress installation
subdirectory is not lost.

Use `site.robots: { "allow_indexing": false }` to request a disallowing
fallback `robots.txt`. Omitting `site.robots` means indexing is allowed.
Legacy `site.indexing` is rejected.

When `widgets` is omitted, the importer materializes the following recommended
sidebar in both preview-data and `wxr-import-base.resolved.json`:

```json
{
  "widgets": {
    "sidebar": {
      "name": "Sidebar Widgets",
      "items": [
        {
          "type": "search",
          "title": "Search",
          "settings": {
            "placeholder": "Search...",
            "button_label": "Search"
          }
        },
        {
          "type": "recent-posts",
          "title": "Recent Posts",
          "settings": {
            "limit": 5,
            "show_date": true
          }
        },
        {
          "type": "categories",
          "title": "Categories",
          "settings": {
            "show_count": false,
            "hierarchical": false
          }
        },
        {
          "type": "tags",
          "title": "Tags",
          "settings": {
            "limit": 20,
            "show_count": false
          }
        },
        {
          "type": "archives",
          "title": "Archives",
          "settings": {
            "limit": 12
          }
        }
      ]
    }
  }
}
```

Use `"widgets": {}` as an explicit opt-out. Any other provided widget object is
preserved exactly; the importer does not add a `sidebar` beside custom areas or
append default items to them. Materializing the fallback in the resolved base
makes the effective default explicit and provides a starting point for a
separately managed base. In that separate base, the English titles may be
changed or set to an empty string to suppress their title markup. The importer
does not synthesize `site.search` or `site.archive`; Build Core filters the
corresponding widget when the effective feature is disabled.

`custom_css`, when present, must use the canonical preview-data object shape:

```json
{
  "custom_css": {
    "content": "body { color: #222; }"
  }
}
```

`content` must contain at least one non-whitespace character. A legacy string
value and additional `custom_css` properties are rejected.

`site.search`, `site.feed`, and `site.archive` use the closed
`{ "enabled": boolean }` shape. Their omission follows the Preview Data default
of enabled; a legacy boolean, an empty object, and extra fields are rejected.
`site.disallow_comments` is not supported. `meta` is copied to `site.meta`
without interpreting or reserving particular keys. Comment-like keys under
`meta` remain ordinary metadata and do not configure the importer; comment API
configuration belongs in the top-level `comments` object. Metadata values must
be strings, numbers, booleans, or `null`; nested objects and arrays are
rejected.

`newsletter` uses the canonical Preview Data newsletter shape and requires an
explicit `enabled` boolean. When `enabled` is `true`, provide at least one safe
`signup_url` or `embed_url`.

The WXR bridge always uses the `wordpress` provider. If a `comments` object is
provided, `api_base_url` is required. Other omitted fields are materialized
into preview-data and the resolved base with these defaults:

```json
{
  "enabled": true,
  "api_base_url": "https://example.com/wp-json/wp/v2",
  "provider": "wordpress",
  "per_page": 50,
  "order": "desc",
  "threading": {
    "enabled": true,
    "max_depth": 2
  }
}
```

`comments.enabled` defaults to `true` in the WXR base contract. Preview Data
and the resolved base always contain the effective boolean. Set it to `false`
to preserve the WordPress provider configuration while disabling the comment
island.

`comments.api_base_url` is the REST API base, not the comments collection URL;
themes append `/comments` and request parameters. An explicit value wins. It
may be an absolute HTTP(S) URL or a root-relative path and may not contain
credentials, a query, or a fragment.

When the complete `comments` object is omitted, the importer selects the first
valid source URL in this order: `wp:base_blog_url`, the channel's direct
`<link>`, then `wp:base_site_url`. A WordPress subdirectory is preserved, so
`https://example.com/blog/` becomes
`https://example.com/blog/wp-json/wp/v2`. `site.url` is deliberately not a
fallback because it can identify the new static site rather than the WordPress
source. If no safe source candidate is available, `site.comments` is omitted
and a `comments_api_base_inference_skipped` warning is emitted. Successful
inference is recorded as `report.inferred.comments_api_base_url`.

### Media URL rewriting

`import.media_from` and `import.media_to` must either both be present or both be
absent. Each value must be an absolute HTTP(S) URL prefix and must not contain:

- username or password credentials;
- a query string; or
- a fragment.

Relative URLs and other schemes are rejected. The importer normalizes both
prefixes to one trailing slash without rewriting their scheme/host spelling
and records the normalized values in the resolved base.

When the pair is omitted, the importer inspects `wp:attachment_url` values. It
automatically seeds the resolved base only when every attachment has a safe
absolute HTTP(S) URL and every URL resolves to the same exact
`/wp-content/uploads/` prefix:

```json
{
  "import": {
    "media_from": "https://blog.example/wp-content/uploads/",
    "media_to": "https://blog.example/wp-content/uploads/"
  }
}
```

The equal pair is an intentional identity state. Runtime prefix rewriting is
skipped. The preview-data `site.media_origin` is inferred from `media_to`, and
structured media fields under that origin are compacted to root-relative paths.
The resolved base retains `site.media_origin: ""` as an automatic-inference
sentinel so changing `media_to` cannot leave a stale inferred origin behind.
For example, media transfer remains a separate operation from WXR conversion:

```sh
cd wp-content/
aws s3 sync uploads s3://your-public-media-bucket/imported
```

After the transfer, copy the resolved snapshot to a separate base file if
needed, change only `media_to` in that file, and run the importer again with
`--base`. When the normalized values differ, only the exact source prefix is
replaced. Inline content, excerpts, and SEO metadata keep absolute destination
URLs. Post/Page `featured_image` and matching `content.media[].src` values are
root-relative when their final URL is under `site.media_origin`; cross-origin
media remains absolute. The normalized `import.media_to` is retained in the
resolved base.

An explicit non-empty `site.media_origin` is preserved and must be an HTTP(S)
origin without credentials, path, query, or fragment. A trailing root slash is
accepted and canonicalized away. When it is empty or omitted, the preview value
is inferred from the effective `media_to` origin and recorded as
`report.inferred.media_origin`, while the resolved base keeps the empty auto
sentinel. The importer does not infer `site.media_delivery_mode` because a
destination URL alone does not prove that ZeroPress image variants are
supported.

For WordPress image attachments referenced by Post/Page `_thumbnail_id`, the
importer reads the top-level original `width` and `height` from
`_wp_attachment_metadata` and the optional alt text from
`_wp_attachment_image_alt`. Referenced images with valid positive dimensions
are emitted once in `content.media`; unreferenced attachments and malformed or
dimensionless metadata are omitted. PHP serialized metadata is scanned without
recursive object deserialization, and a compact JSON metadata form is also
accepted.

Inference is deliberately all-or-nothing. Mixed origins, custom upload paths,
missing URLs, malformed URLs, unsafe credentials, or any attachment outside
the common default WordPress uploads prefix leave `import` unset and produce a
warning. Content and channel URLs are not used as fallback evidence. Sites with
no attachments leave `import` unset without a warning.
Successful automatic inference is also recorded as
`report.inferred.media_prefix`; its effective origin is recorded as
`report.inferred.media_origin`.

## Conversion policy

- Only published WordPress posts and pages are exported. Password-protected
  content is excluded.
- WordPress post IDs are preserved as `post.public_id`.
- WordPress page IDs are used for deterministic path conflict handling and are
  preserved as `page.public_id`.
- WordPress `wp:comment_status` maps exactly: `open` emits
  `allow_comments: true`; `closed` omits the field and therefore uses the
  Preview Data default of `false`. Missing or unknown values also fail closed,
  omit the field, and emit an `invalid_comment_statuses` warning for the
  affected Post or Page.
- WXR categories, tags, authors, and nav menus are converted when possible.
  Taxonomy menu items support both categories and tags.
- Category and tag slugs are normalized in separate taxonomy namespaces. If
  two distinct source slugs in the same taxonomy normalize to the same slug,
  the complete conversion fails and identifies both terms instead of silently
  discarding one. This applies across top-level declarations and inline
  `<category>` elements. Repeated inline references to the same source slug
  remain valid. A category and tag may share the same normalized slug.
- Each Post's `tag_slugs` preserves the order of its WXR
  `<category domain="post_tag">` elements and removes later occurrences of the
  same slug. The global `content.tags` catalog is instead sorted by name and
  then slug using a locale-independent lexical comparison.
- Distinct WordPress navigation menu slugs that normalize to the same slug
  fail the complete conversion and identify both menu sources. Repeated menu
  item assignments to the same source slug remain valid.
- Generated menu IDs resolve ordinary output-ID conflicts with numeric suffixes.
  If 1,000 menus map to the same ID family, conversion fails with the affected
  menu context instead of continuing indefinitely.
- Menu item `type` is not emitted.
- Datetimes are emitted as UTC seconds: `YYYY-MM-DDTHH:mm:ssZ`.
- Custom menu URLs on the WXR source origin become root-relative URLs. External
  HTTP(S) URLs are preserved.
- Every non-empty WXR menu URL must be a credential-free absolute HTTP(S) URL
  or a safe single-slash root-relative URL. Illegal values fail the complete
  conversion instead of being silently removed. This includes path traversal
  such as `/../secret`, backslashes such as `/foo\bar`, malformed percent
  encoding such as `/foo%ZZ`, protocol-relative or non-HTTP(S) URLs, and
  absolute URLs containing credentials. The error identifies the menu, item
  ID, title, URL, and rejection reason. No output or helper artifact is
  committed when this validation fails.

### Locale

An explicit `site.locale` is canonicalized with
`Intl.getCanonicalLocales()` and invalid BCP 47 values fail conversion. When
the value is omitted, the WXR channel `<language>` is canonicalized. A missing
or invalid inferred value falls back to `en` and emits
`locale_inference_skipped` in the report and stderr.

### Time zone

An explicit non-blank `site.timezone` is authoritative. The importer trims and
canonicalizes it with the JavaScript internationalization runtime; valid IANA
identifiers and canonical `±HH:MM` offsets are supported. Invalid values fail
the conversion instead of reaching Build Core.

When `site.timezone` is omitted, the importer compares `wp:post_date` with
`wp:post_date_gmt` for published, non-password-protected Posts and Pages that
otherwise have valid IDs and required GMT dates. It infers a fixed offset only
when every trustworthy pair agrees. A zero offset becomes `UTC`; another
offset is emitted as `±HH:MM`. Successful inference is recorded as
`report.inferred.timezone` without a warning. No usable evidence falls back to
`UTC` with `timezone_inference_skipped`; multiple offsets (including a typical
DST export) fall back to `UTC` with `timezone_inference_ambiguous`. In the
latter cases, set an explicit IANA identifier such as `America/New_York` in the
base rather than choosing a majority offset.
An ambiguous warning's `affected` array contains the sorted unique canonical
offsets, and its `count` is the number of those offsets.

The effective value is materialized in preview-data and the resolved base.
Date tokens inferred from WordPress links use the WXR local date, while emitted
Post and menu URLs calculate `:year`, `:month`, and `:day` in the effective
site time zone.

If `site.permalinks` is omitted, the importer tries to infer `posts`, `pages`,
and `output_style` from same-origin WXR item links. An explicit base permalink
always wins. Page inference treats the complete WordPress ancestor lineage as
the `:slug` portion so hierarchy is not duplicated. Category and tag patterns
are not inferred, so provide them when
WordPress uses a custom taxonomy URL shape.
The preview-data and resolved base always materialize the complete effective
permalink policy. For readability, every pattern has exactly one trailing slash
when `output_style` is `directory`, and no trailing slash when it is
`html-extension`. This canonical spelling also applies to explicit patterns;
it does not change the generated routes or accepted base-file syntax.
Literal path and imported slug segments may contain isolated internal dots such
as `v0.6`; leading, trailing, or consecutive dots are repaired or rejected as
appropriate before preview-data is produced.

### Page hierarchy

Page paths retain the WordPress `wp:post_parent` hierarchy. The resolved
`parent/child` path replaces `:slug` in the effective page permalink pattern,
and page menu URLs use that resolved path. Preview Data omits `page.path` when
the effective permalink fallback produces the same public URL and output file.
Nested, collision-resolved, custom, and `html-extension` terminal `index`
routes keep an explicit path.

Page references use that same effective route path rather than the Page leaf
slug. A Page front page is written as
`{ "type": "page", "page_path": "docs/about" }`, and a Page collection
item as `{ "type": "page", "path": "docs/about" }`. Post collection items
continue to use `slug`. References are validated against the converted
content, so two Pages may share a leaf slug when their effective paths differ.

- A missing or excluded parent promotes the child to the root and emits an
  `orphan_page_parents` warning.
- A self-parent or page-parent cycle fails the entire conversion.
- A resolved sibling path collision is made deterministic by suffixing the last
  segment with the WordPress page ID and emits a
  `resolved_page_path_conflicts` warning.

Menu hierarchy is processed separately. Missing menu parents promote their
children to menu roots. Depths 1 through 10 are retained; a depth-11 item and
its descendants are discarded. Menu cycles and their descendant subtrees are
also discarded without preventing unrelated menus from being converted.

## Reports and warnings

The report exposes warnings with one stable shape:

```json
{
  "warnings": {
    "orphan_page_parents": {
      "count": 1,
      "affected": ["42"]
    }
  }
}
```

Defined warning codes include:

- `skipped_menu_items`
- `synthesized_authors`
- `orphan_page_parents`
- `orphan_menu_parents`
- `resolved_page_path_conflicts`
- `discarded_deep_menu_items`
- `discarded_cyclic_menu_items`
- `media_prefix_inference_skipped`
- `unresolved_featured_images`
- `comments_api_base_inference_skipped`
- `invalid_comment_statuses`
- `locale_inference_skipped`
- `timezone_inference_skipped`
- `timezone_inference_ambiguous`

`skipped_menu_items` covers incomplete or unresolved menu items, such as a
missing title, missing URL, or missing referenced content. It is not used for a
non-empty illegal URL; that input fails the conversion as described above.

Media-prefix inference warnings identify attachment records as
`attachment:<wordpress-id>` (or `item:<channel-index>` when the attachment ID is
missing). Unresolved featured-image warnings identify the reference as
`post:<wordpress-id>:attachment:<wordpress-id>` or the corresponding `page:`
form.

Every nonzero warning is printed to stderr with a `WARN` prefix whether or not
the JSON report is enabled. Invalid WordPress IDs and dates are also reported on
stderr. Counts for policy exclusions such as unpublished and
password-protected content appear in the success summary on stdout.

Warnings do not change a successful exit status. Invalid arguments, invalid
base data, unsafe file plans, malformed/unsupported WXR, page cycles, validation
failures, and write failures exit with status 1.

Values WXR cannot reliably provide—such as theme-specific metadata, newsletter
settings, and custom category/tag permalink policy—belong in the base file.

## License

MIT

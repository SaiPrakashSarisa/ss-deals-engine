# @ss-deals/core

Pure helpers shared by the quick-post bot and, later, the web app. There is no Telegram client, no I/O, no environment access, no network, and no database.

`formatPost` still takes whole rupees. `rupeesToPaise` and `paiseToRupees` are extra converters for storage that uses integer paise (100 paise = 1 rupee). They do not change the caption.

Build with `pnpm --filter @ss-deals/core build`. The package exports plain ESM from `dist`, with type declarations. Import `@ss-deals/core` after that build.

## `parseAmazonProductUrl(raw, tag)`

Accepts an `http` or `https` link on `amazon.in`, `www.amazon.in`, or `m.amazon.in` whose path contains `/dp/<ASIN>` or `/gp/product/<ASIN>`. The ASIN is 10 letters or digits. The result is `{ ok: true, asin, url }` where `url` is `https://www.amazon.in/dp/<ASIN>?tag=<tag>`. Any other query parameter, fragment, userinfo, or tag already on the pasted URL is dropped.

Returns `{ ok: false, message }` when the link is not an amazon.in product URL. Short hosts `amzn.to`, `amzn.asia`, `amzn.eu`, `amzn.in`, and `a.co` (and the same hosts with a `www.` prefix) use the message in `SHORT_LINK_MESSAGE`: `Please paste the full amazon.in product link`.

## `buildTaggedUrl(asin, tag)`

Builds `https://www.amazon.in/dp/<asin>?tag=<tag>`. `buildTaggedProductUrl` is the same function.

## `validateShortLink(raw, hosts)`

Checks an optional short link without requesting it. Returns `{ ok: true, url }` when `raw` is an `https` URL and its hostname is in `hosts` (compared after lowercasing the allowlist). `url` is the original string. Any other input returns `{ ok: false }`. The caller supplies the allowlist. This package does not read `SHORT_LINK_HOSTS`.

## `parsePriceInput(raw)`

Parses a positive whole number of rupees. `1499`, `1,499`, and `₹1,499` are accepted, including Indian grouping such as `1,49,999`. Returns `undefined` for anything else, including zero, decimals, and text. `parseRupeeAmount` is the same function.

## `formatRupees(amount)`

Formats a number with Indian grouping (`en-IN`, no fraction digits), so `149999` becomes `1,49,999`.

## `rupeesToPaise(rupees)` and `paiseToRupees(paise)`

`rupeesToPaise` multiplies a non-negative integer number of rupees by 100. `paiseToRupees` divides a non-negative integer number of paise by 100 and returns whole rupees. Whole rupees round-trip: `paiseToRupees(rupeesToPaise(n)) === n`.

Both throw `TypeError` for a value that is not a non-negative safe integer, including negatives, `-0`, fractions, `NaN`, and infinities. `paiseToRupees` throws `RangeError` when the paise are not a multiple of 100. `rupeesToPaise` throws `RangeError` when the paise product is not a safe integer.

## `findForbiddenWords(text)`

Returns the phrases from `hurry`, `last chance`, `loot`, `lowest ever`, and `limited time` that occur in `text`, case-insensitive, as substrings. It does not remove them. `findForbiddenPhrases` is the same function. `FORBIDDEN_PHRASES` is that list.

## `formatPost(input)`

Builds the Telegram HTML caption. Amounts are whole rupees and are formatted with `formatRupees`.

`FormatInput`:

| Field        | Type                           | Role                                                                    |
| ------------ | ------------------------------ | ----------------------------------------------------------------------- |
| `title`      | `string`                       | First line, bold, after 🔥                                              |
| `price`      | `number`                       | Deal price in whole rupees                                              |
| `oldPrice`   | `number` (optional)            | Previous price in whole rupees                                          |
| `verified`   | `boolean`                      | When true with `oldPrice`, strike the old price and show percent off    |
| `highlights` | `string[]`                     | Up to three lines are included, each starting with ✨                   |
| `offer`      | `string` (optional)            | Extra price-block line                                                  |
| `linkUrl`    | `string`                       | Visible link and, when requested, the button URL                        |
| `linkStyle`  | `'text' \| 'button' \| 'both'` | `text` is the Buy Here line, `button` is the URL button, `both` is both |
| `footer`     | `string` (optional)            | Italic last block. Empty or missing adds nothing                        |

`FormatResult` is `{ ok: true, html, urlButton?, warnings }` or `{ ok: false, message }`. `html` must be shorter than 900 characters (`MAX_CAPTION_LENGTH`), counting tags. `urlButton` is `{ text: AMAZON_BUTTON_LABEL, url }` for `button` and `both`. Warnings cover forbidden phrases in the title or highlights, and a highlight list longer than three. User text is HTML-escaped. The caption does not use a blockquote or an `<a>` tag.

`LinkStyle`, `discountPercent`, and `escapeHtml` are exported as well. `discountPercent` is `round((old - price) / old * 100)`.

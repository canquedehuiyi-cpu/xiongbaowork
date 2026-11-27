/*
 * The MIT notice of the code this product was first built from. The licence asks for its copyright line
 * and permission notice to travel with the code, so THIRD-PARTY-NOTICES.md opens with it
 * (scripts/brand/third-party-notices.ts writes that file at build time) and the About page lists it among
 * the open-source software the product uses. It is the one licence text the brand guard lets name the
 * holder, and only here (scripts/brand/guard/scan.ts, LICENCE_FILE).
 */
export const LICENCE_PARAGRAPH = `MIT License

Copyright (c) 2026 CopilotKit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The holder, read from the copyright line above so its name is written once. */
export const LICENCE_HOLDER =
  LICENCE_PARAGRAPH.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]?.trim() ??
  "MIT";

/** The paragraph as one row of the third-party notices: no version of its own, so the version reads "—". */
export const LICENCE_NOTICE = {
  name: LICENCE_HOLDER,
  version: "—",
  license: "MIT",
  licenseText: LICENCE_PARAGRAPH,
};

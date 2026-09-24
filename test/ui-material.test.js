import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReviewPage } from "../src/ui/page.js";

// The page is Material Design 3, and this is what that means mechanically
// rather than by eye: the token sets exist and are complete, every component
// reads them instead of a literal, the state layer is on everything that takes
// a pointer, and the window-size classes are the ones Material names.
//
// Looking at it is still the real check — these only catch the erosion that a
// screenshot taken once cannot.

const page = renderReviewPage("test-token");
const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const body = page.slice(page.indexOf("</style>"));

test("the colour scheme is complete, in both light and dark", () => {
  // Every Material role this page uses has a partner: a colour with no
  // 'on-' colour is a colour nothing can be written on.
  const roles = [
    "primary", "on-primary", "primary-container", "on-primary-container",
    "secondary", "on-secondary", "secondary-container", "on-secondary-container",
    "tertiary", "on-tertiary", "tertiary-container", "on-tertiary-container",
    "error", "on-error", "error-container", "on-error-container",
    "surface", "on-surface", "on-surface-variant", "outline", "outline-variant",
    "surface-container-lowest", "surface-container-low", "surface-container",
    "surface-container-high", "surface-container-highest",
    "inverse-surface", "inverse-on-surface", "inverse-primary",
  ];
  const dark = style.slice(style.indexOf("prefers-color-scheme: dark"));
  for (const role of roles) {
    assert.match(style, new RegExp("--md-" + role + ":\\s*#"), role + " is not defined");
  }
  // The dark scheme redefines the ones that must differ. A role left at its
  // light value is the classic way a dark theme turns unreadable.
  for (const role of ["primary", "on-primary", "surface", "on-surface", "outline", "error", "on-error-container"]) {
    assert.match(dark, new RegExp("--md-" + role + ":\\s*#"), role + " is not redefined for dark");
  }
  // ETNPilot's extra pair is declared in both, and said to be extra.
  assert.match(style, /--md-warning:/);
  assert.match(style, /--md-on-warning-container:/);
  assert.match(dark, /--md-warning:/);
  assert.match(style, /Material 3 has no 'warning' role/);
});

test("the type, shape, elevation and motion scales are there and are used", () => {
  for (const role of ["headline-small", "title-large", "title-medium", "title-small", "body-large", "body-medium", "body-small", "label-large", "label-medium", "label-small"]) {
    assert.match(style, new RegExp("--md-" + role + ":"), role);
  }
  // Material's shape scale, to the corner radii it names.
  assert.match(style, /--md-shape-xs: 4px/);
  assert.match(style, /--md-shape-sm: 8px/);
  assert.match(style, /--md-shape-md: 12px/);
  assert.match(style, /--md-shape-lg: 16px/);
  assert.match(style, /--md-shape-xl: 28px/);
  for (const level of [1, 2, 3, 4, 5]) assert.match(style, new RegExp("--md-elevation-" + level + ":"));
  assert.match(style, /--md-ease-standard: cubic-bezier\(\.2, 0, 0, 1\)/);
  assert.match(style, /--md-duration-short: 200ms/);
  // Dialogs take the extra-large shape, chips the small one, buttons the full
  // one: the scale is applied, not merely declared.
  assert.match(style, /\.modal \{[^}]*--md-shape-xl/s);
  assert.match(style, /\.btn \{[^}]*--md-shape-full/s);
});

test("nothing hard-codes a colour outside the token block", () => {
  // Everything after the token declarations must reach for a role. A literal
  // there is a colour that will not follow the scheme into dark mode.
  const afterTokens = style.slice(style.indexOf("* { box-sizing: border-box; }"));
  const literals = [...afterTokens.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
  assert.deepEqual(literals, [], "hard-coded colours: " + literals.join(", "));
  // rgba() is allowed only in the elevation shadows, which are black by
  // definition in both schemes.
  const shadows = afterTokens.match(/rgba\([^)]*\)/g) ?? [];
  assert.deepEqual(shadows, []);
});

test("the state layer is on everything that takes a pointer", () => {
  assert.match(style, /\.state::after \{/);
  assert.match(style, /--md-state-hover: \.08/);
  assert.match(style, /--md-state-focus: \.10/);
  assert.match(style, /--md-state-press: \.10/);
  // The controls written into the markup carry it, and so does every button
  // the script builds.
  for (const id of ["menu", "open-palette", "open-run", "run-submit", "fab-run"]) {
    const tag = body.slice(body.indexOf('id="' + id + '"') - 160, body.indexOf('id="' + id + '"'));
    assert.match(tag, /class="[^"]*state/, id + " has no state layer");
  }
  assert.match(page, /className\.includes\("state"\) \? className : className \+ " state"/);
  // And a visible focus indicator, which is the one state a keyboard has.
  assert.match(style, /:focus-visible \{\s*outline: 3px solid var\(--md-primary\)/);
});

test("the window size classes are Material's, and each one changes the navigation", () => {
  // Expanded: a standard drawer beside the content. Medium: the same drawer,
  // modal, over a scrim. Compact: a bottom navigation bar and a FAB.
  assert.match(style, /--md-nav-drawer: 280px; --md-nav-rail: 80px/);
  assert.match(style, /@media \(max-width: 900px\)/);
  assert.match(style, /@media \(max-width: 600px\)/);
  const compact = style.slice(style.indexOf("@media (max-width: 600px)"));
  assert.match(compact, /\.nav-bar \{/);
  assert.match(compact, /\.fab \{ display: flex; \}/);
  assert.match(compact, /#open-run \{ display: none; \}/);
  // Both navigations are filled from one list, so they cannot disagree about
  // which views exist.
  assert.match(page, /const nav = \$\("nav"\);\s*const bar = \$\("nav-bar"\);/);
  // Material's bottom bar takes three to five destinations; the rest go
  // behind 'More', which opens the drawer.
  assert.match(page, /const BAR_VIEWS = \[/);
  const bar = page.match(/const BAR_VIEWS = \[([^\]]*)\]/)[1].split(",").filter((entry) => entry.trim());
  assert.equal(bar.length >= 3 && bar.length <= 4, true, "with 'More' that is four to five items");
  assert.match(page, /"aria-label": "More views: "/);
});

test("touch targets, reduced motion and the theme colour follow the scheme", () => {
  const coarse = style.slice(style.indexOf("@media (pointer: coarse)"));
  assert.match(coarse, /\.btn \{ min-height: 48px; \}/);
  assert.match(coarse, /\.btn\.icon \{ width: 48px; min-height: 48px; \}/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/);
  // The browser's own chrome matches the scheme it is showing.
  assert.match(page, /<meta name="theme-color" content="#f5fbf8" media="\(prefers-color-scheme: light\)">/);
  assert.match(page, /<meta name="theme-color" content="#0e1513" media="\(prefers-color-scheme: dark\)">/);
});

test("the page still carries nothing from a network", () => {
  // The typeface is the system's for a reason this test states, so that a
  // later 'make it Roboto' has to argue with it.
  assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(page), false, "the page would load something remote");
  assert.match(style, /uses the system sans, not Roboto/);
});

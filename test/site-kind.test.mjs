/*
 * What kind of site a cited page lives on, for brands in any market and of
 * any kind (src/lib/siteKind.js, 0.69.0). Run: node test/site-kind.test.mjs
 *
 * Reported: "this tool is made for people across the world, for every type
 * of brand and product". Before 0.69.0 the lists knew Indian and US shops
 * and phone review sites; a Brazilian marketplace, a German retailer, a
 * government page or a university study were all "Other".
 */
import { siteKindOf, KIND_GROUPS, isPublicOrReference } from "../src/lib/siteKind.js";
import { isPlausibleProseName } from "../src/lib/brands.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const kinds = (ds, ctx) => ds.map((d) => siteKindOf(d, ctx));
const all = (label, ds, want, ctx) => { const got = kinds(ds, ctx); check(label, got.every((k) => k === want), JSON.stringify(ds.map((d, i) => [d, got[i]]))); };

console.log("groups");
check("Public & reference sits before Other", KIND_GROUPS.indexOf("Public & reference") === KIND_GROUPS.length - 2, KIND_GROUPS.join());

console.log("marketplaces and shops in other markets");
all("marketplaces", ["mercadolivre.com.br", "www.mercadolibre.com.mx", "allegro.pl", "bol.com", "www.zalando.de", "coupang.com", "shopee.co.id", "noon.com", "jumia.com.ng", "takealot.com", "amazon.co.jp", "rakuten.co.jp", "temu.com"], "Retailers");
all("retail chains", ["www.mediamarkt.de", "fnac.com", "johnlewis.com", "jbhifi.com.au", "yodobashi.com", "ikea.com", "magazineluiza.com.br"], "Retailers");

console.log("government, universities, research and reference");
all("public bodies", ["www.gov.uk", "service-public.gouv.fr", "www.gob.mx", "www.mhlw.go.jp", "www.irs.gov", "ec.europa.eu", "www.who.int", "www.canada.gc.ca", "www.govt.nz", "india.gov.in"], "Public & reference");
all("universities", ["www.mit.edu", "www.ox.ac.uk", "www.unimelb.edu.au", "iitb.ac.in", "u-tokyo.ac.jp"], "Public & reference");
all("reference and analysts", ["en.wikipedia.org", "britannica.com", "www.statista.com", "www.gartner.com", "www.forrester.com", "pubmed.ncbi.nlm.nih.gov", "arxiv.org"], "Public & reference");
check("helper", isPublicOrReference("data.gov") && !isPublicOrReference("zento.com"));
check("not every .go is a government: google.com stays Other", siteKindOf("google.com") === "Other");

console.log("reviews and news anywhere");
all("editorial", ["www.nytimes.com", "www.bbc.co.uk", "www.which.co.uk", "rtings.com", "www.g2.com", "capterra.com", "www.chip.de", "xataka.com", "kakaku.com", "www.nerdwallet.com"], "Review sites");
all("forums and communities", ["zhihu.com", "www.naver.com", "stackexchange.com", "discord.com"], "Forums & social");

console.log("your site still wins");
check("own .gov site is yours", siteKindOf("kovo.gov.uk", { ownBrand: "Kovo", ownUrl: "kovo.gov.uk" }) === "Your site");

console.log("countries and currencies are not brands");
for (const w of ["Brazil", "Germany", "United Kingdom", "Japan", "Nigeria", "Euro", "Dollars", "Europe"]) check(`"${w}" is refused`, !isPlausibleProseName(w));
check("a real brand name is kept", isPlausibleProseName("Zento"));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

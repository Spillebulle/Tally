# Where these marks come from

Age-rating symbols used to show the certificate a title actually carries.
201 files across 36 boards, vendored from Wikimedia Commons.

**Copyright.** Every file is **public domain**, bar Turkey's eight, which are
**CC0** — a waiver with no attribution requirement, so it carries no obligation
public domain does not. Commons tags the rest `PD-textlogo` / `PD-ineligible`:
the symbols consist of simple geometry and text, which does not meet the
threshold of originality for copyright. Each file's tag was checked before it
was taken, not assumed.

**Trademark.** The symbols are nonetheless registered trademarks of their
boards, and the Commons files carry the `trademarked` notice: *"This work
includes material that may be protected as a trademark in some jurisdictions.
If you want to use it, you have to ensure that you have the legal right to do
so."* Tally displays them descriptively — to state the rating a title was
given. Boards set their own terms for other uses; the BBFC, for instance,
licenses symbol use on VOD services under direct licence.

**Edits.** Some files carried `width`/`height` but no `viewBox`, so they would
not scale inside an `<img>`; a `viewBox` matching the declared size was added.
Nothing else in any file was changed. An earlier attempt to strip editor
metadata silently broke five files by removing an `xmlns` whose prefix was
still in use, so the files are now left exactly as published and every one is
checked to parse as XML.

## Known rough edges

**Denmark is heavy.** The four Medierådet files are 94–293 kB each, about half
of this directory, because the artwork is detailed vector — one has 666 paths.
No smaller official version is published.

**New Zealand is wide.** The OFLC 2022 marks are the "label" form, roughly 4:1,
carrying a line of descriptor text that is unreadable at badge size. No compact
variant is published; the label shown beside the mark carries the meaning.

**Some boards have more than one version.** Ireland uses the cinema marks,
which are a fiftieth the size of the home-video ones. France uses the
CSA/Arcom broadcast signage, the country's standard age marking; `Tous
publics` is a phrase rather than a symbol and has no file.

**Size.** This directory is about 8.5 MB, and four boards are most of it:
Nigeria (2.7 MB), the Maldives (1.9 MB), Iceland (1.5 MB) and Denmark (0.7 MB).
Their artwork is genuinely intricate vector — several files carry 600–900 paths
— and none of that detail survives at 20 px. Nothing is inlined into the JS
bundle, so a page fetches only the marks it shows, but the repository carries
the whole set.

## Not included

**Sweden.** Statens medieråd publish no free symbol and none appears on
Commons. `Btl`, `7`, `11` and `15` fall back to the age disc.

**Hong Kong.** Every variant on Commons — both the `cat*` and the `Level *`
families — is CC BY-SA 3.0. Share-alike on a bundled asset is an obligation
nothing else here carries.

**Malaysia (LPF).** The five 2023 files are not vector at all: each is a single
base64 raster wrapped in an SVG, 2.5–2.9 MB apiece, 13.4 MB for the set. They
would have been the largest thing in the repository by a wide margin and would
still look worse than a drawn disc.

**The Philippines and Russia.** Each has one file that charts the whole system
rather than one file per rating, so there is nothing to attach to a single
certificate.

**Gmedia and UMC.** Both are labelled only by rating, with no country stated on
the file, so there is no region to key them to. UMC's are also 0.4–0.7 MB each.

Anything without a mark — legacy codes such as `GP`, `gb/Uc`, `au/RC`,
`nz/RP16` — falls back to the disc or to plain boxed text.

## BBFC (United Kingdom)

| File | Source | Licence | Edited |
|---|---|---|---|
| `bbfc-u.svg` | [BBFC U 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_U_2019.svg) | Public domain | — |
| `bbfc-pg.svg` | [BBFC PG 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_PG_2019.svg) | Public domain | — |
| `bbfc-12a.svg` | [BBFC 12A 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_12A_2019.svg) | Public domain | — |
| `bbfc-12.svg` | [BBFC 12 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_12_2019.svg) | Public domain | — |
| `bbfc-15.svg` | [BBFC 15 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_15_2019.svg) | Public domain | — |
| `bbfc-18.svg` | [BBFC 18 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_18_2019.svg) | Public domain | — |
| `bbfc-r18.svg` | [BBFC R18 2019.svg](https://commons.wikimedia.org/wiki/File:BBFC_R18_2019.svg) | Public domain | — |

## MPA (United States, film)

| File | Source | Licence | Edited |
|---|---|---|---|
| `mpa-g.svg` | [MPA G RATING.svg](https://commons.wikimedia.org/wiki/File:MPA_G_RATING.svg) | Public domain | — |
| `mpa-pg.svg` | [MPA PG RATING.svg](https://commons.wikimedia.org/wiki/File:MPA_PG_RATING.svg) | Public domain | — |
| `mpa-pg-13.svg` | [MPA PG-13 RATING.svg](https://commons.wikimedia.org/wiki/File:MPA_PG-13_RATING.svg) | Public domain | — |
| `mpa-r.svg` | [MPA R RATING.svg](https://commons.wikimedia.org/wiki/File:MPA_R_RATING.svg) | Public domain | — |
| `mpa-nc-17.svg` | [MPA NC-17 RATING.svg](https://commons.wikimedia.org/wiki/File:MPA_NC-17_RATING.svg) | Public domain | — |
| `mpa-x.svg` | [MPAA X RATING.svg](https://commons.wikimedia.org/wiki/File:MPAA_X_RATING.svg) | Public domain | — |

## US TV Parental Guidelines

| File | Source | Licence | Edited |
|---|---|---|---|
| `ustv-tv-y.svg` | [TV-Y icon.svg](https://commons.wikimedia.org/wiki/File:TV-Y_icon.svg) | Public domain | — |
| `ustv-tv-y7.svg` | [TV-Y7 icon.svg](https://commons.wikimedia.org/wiki/File:TV-Y7_icon.svg) | Public domain | — |
| `ustv-tv-y7-fv.svg` | [TV-Y7-FV icon.svg](https://commons.wikimedia.org/wiki/File:TV-Y7-FV_icon.svg) | Public domain | — |
| `ustv-tv-g.svg` | [TV-G icon.svg](https://commons.wikimedia.org/wiki/File:TV-G_icon.svg) | Public domain | — |
| `ustv-tv-pg.svg` | [TV-PG icon.svg](https://commons.wikimedia.org/wiki/File:TV-PG_icon.svg) | Public domain | — |
| `ustv-tv-14.svg` | [TV-14 icon.svg](https://commons.wikimedia.org/wiki/File:TV-14_icon.svg) | Public domain | — |
| `ustv-tv-ma.svg` | [TV-MA icon.svg](https://commons.wikimedia.org/wiki/File:TV-MA_icon.svg) | Public domain | — |

## FSK (Germany)

| File | Source | Licence | Edited |
|---|---|---|---|
| `fsk-0.svg` | [FSK 0.svg](https://commons.wikimedia.org/wiki/File:FSK_0.svg) | Public domain | — |
| `fsk-6.svg` | [FSK 6.svg](https://commons.wikimedia.org/wiki/File:FSK_6.svg) | Public domain | — |
| `fsk-12.svg` | [FSK 12.svg](https://commons.wikimedia.org/wiki/File:FSK_12.svg) | Public domain | — |
| `fsk-16.svg` | [FSK 16.svg](https://commons.wikimedia.org/wiki/File:FSK_16.svg) | Public domain | — |
| `fsk-18.svg` | [FSK 18.svg](https://commons.wikimedia.org/wiki/File:FSK_18.svg) | Public domain | — |

## Kijkwijzer (Netherlands)

| File | Source | Licence | Edited |
|---|---|---|---|
| `kijkwijzer-al.svg` | [Kijkwijzer AL.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_AL.svg) | Public domain | viewBox added |
| `kijkwijzer-6.svg` | [Kijkwijzer 6.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_6.svg) | Public domain | viewBox added |
| `kijkwijzer-9.svg` | [Kijkwijzer 9.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_9.svg) | Public domain | viewBox added |
| `kijkwijzer-12.svg` | [Kijkwijzer 12.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_12.svg) | Public domain | viewBox added |
| `kijkwijzer-14.svg` | [Kijkwijzer 14.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_14.svg) | Public domain | — |
| `kijkwijzer-16.svg` | [Kijkwijzer 16.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_16.svg) | Public domain | viewBox added |
| `kijkwijzer-18.svg` | [Kijkwijzer 18.svg](https://commons.wikimedia.org/wiki/File:Kijkwijzer_18.svg) | Public domain | — |

## Medietilsynet (Norway)

| File | Source | Licence | Edited |
|---|---|---|---|
| `no-a.svg` | [Norwegian Rating A.svg](https://commons.wikimedia.org/wiki/File:Norwegian_Rating_A.svg) | Public domain | — |
| `no-6.svg` | [Norwegian Rating 6.svg](https://commons.wikimedia.org/wiki/File:Norwegian_Rating_6.svg) | Public domain | — |
| `no-9.svg` | [Norwegian Rating 9.svg](https://commons.wikimedia.org/wiki/File:Norwegian_Rating_9.svg) | Public domain | — |
| `no-12.svg` | [Norwegian Rating 12.svg](https://commons.wikimedia.org/wiki/File:Norwegian_Rating_12.svg) | Public domain | — |
| `no-15.svg` | [Norwegian Rating 15.svg](https://commons.wikimedia.org/wiki/File:Norwegian_Rating_15.svg) | Public domain | — |
| `no-18.svg` | [Norwegian Rating 18.svg](https://commons.wikimedia.org/wiki/File:Norwegian_Rating_18.svg) | Public domain | — |

## ACB (Australia)

| File | Source | Licence | Edited |
|---|---|---|---|
| `acb-g.svg` | [Australian Classification General (G).svg](https://commons.wikimedia.org/wiki/File:Australian_Classification_General_(G).svg) | Public domain | viewBox added |
| `acb-pg.svg` | [Australian Classification Parental Guidance (PG).svg](https://commons.wikimedia.org/wiki/File:Australian_Classification_Parental_Guidance_(PG).svg) | Public domain | viewBox added |
| `acb-m.svg` | [Australian Classification Mature (M).svg](https://commons.wikimedia.org/wiki/File:Australian_Classification_Mature_(M).svg) | Public domain | viewBox added |
| `acb-ma15.svg` | [Australian Classification Mature 15+ (MA 15+).svg](https://commons.wikimedia.org/wiki/File:Australian_Classification_Mature_15+_(MA_15+).svg) | Public domain | viewBox added |
| `acb-r18.svg` | [Australian Classification Restricted 18+ (R 18+).svg](https://commons.wikimedia.org/wiki/File:Australian_Classification_Restricted_18+_(R_18+).svg) | Public domain | viewBox added |
| `acb-x18.svg` | [Australian Classification Restricted 18+ (X 18+).svg](https://commons.wikimedia.org/wiki/File:Australian_Classification_Restricted_18+_(X_18+).svg) | Public domain | viewBox added |

## DJCTQ (Brazil)

| File | Source | Licence | Edited |
|---|---|---|---|
| `djctq-l.svg` | [DJCTQ - L.svg](https://commons.wikimedia.org/wiki/File:DJCTQ_-_L.svg) | Public domain | viewBox added |
| `djctq-10.svg` | [DJCTQ - 10.svg](https://commons.wikimedia.org/wiki/File:DJCTQ_-_10.svg) | Public domain | viewBox added |
| `djctq-12.svg` | [DJCTQ - 12.svg](https://commons.wikimedia.org/wiki/File:DJCTQ_-_12.svg) | Public domain | viewBox added |
| `djctq-14.svg` | [DJCTQ - 14.svg](https://commons.wikimedia.org/wiki/File:DJCTQ_-_14.svg) | Public domain | viewBox added |
| `djctq-16.svg` | [DJCTQ - 16.svg](https://commons.wikimedia.org/wiki/File:DJCTQ_-_16.svg) | Public domain | viewBox added |
| `djctq-18.svg` | [DJCTQ - 18.svg](https://commons.wikimedia.org/wiki/File:DJCTQ_-_18.svg) | Public domain | viewBox added |

## Eirin (Japan)

| File | Source | Licence | Edited |
|---|---|---|---|
| `eirin-g.svg` | [Eirin Rated G.svg](https://commons.wikimedia.org/wiki/File:Eirin_Rated_G.svg) | Public domain | — |
| `eirin-pg12.svg` | [Eirin Rated PG12.svg](https://commons.wikimedia.org/wiki/File:Eirin_Rated_PG12.svg) | Public domain | — |
| `eirin-r15.svg` | [Eirin Rated R15+.svg](https://commons.wikimedia.org/wiki/File:Eirin_Rated_R15+.svg) | Public domain | — |
| `eirin-r18.svg` | [Eirin Rated R18+.svg](https://commons.wikimedia.org/wiki/File:Eirin_Rated_R18+.svg) | Public domain | — |

## Mibact (Italy)

| File | Source | Licence | Edited |
|---|---|---|---|
| `it-t.svg` | [Mibact Tutti.svg](https://commons.wikimedia.org/wiki/File:Mibact_Tutti.svg) | Public domain | — |
| `it-vm6.svg` | [Mibact Minori6anni.svg](https://commons.wikimedia.org/wiki/File:Mibact_Minori6anni.svg) | Public domain | — |
| `it-vm10.svg` | [Mibact Minori10anni.svg](https://commons.wikimedia.org/wiki/File:Mibact_Minori10anni.svg) | Public domain | — |
| `it-vm14.svg` | [Mibact Minori14anni.svg](https://commons.wikimedia.org/wiki/File:Mibact_Minori14anni.svg) | Public domain | — |
| `it-vm18.svg` | [Mibact Minori18anni.svg](https://commons.wikimedia.org/wiki/File:Mibact_Minori18anni.svg) | Public domain | — |

## OFLC (New Zealand), 2022 labels

| File | Source | Licence | Edited |
|---|---|---|---|
| `oflc-g.svg` | [OFLC G label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_G_label_(2022).svg) | Public domain | — |
| `oflc-pg.svg` | [OFLC PG label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_PG_label_(2022).svg) | Public domain | — |
| `oflc-m.svg` | [OFLC M label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_M_label_(2022).svg) | Public domain | — |
| `oflc-r13.svg` | [OFLC Restricted 13 (R13) label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_Restricted_13_(R13)_label_(2022).svg) | Public domain | — |
| `oflc-r15.svg` | [OFLC Restricted 15 (R15) label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_Restricted_15_(R15)_label_(2022).svg) | Public domain | — |
| `oflc-r16.svg` | [OFLC Restricted 16 (R16) label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_Restricted_16_(R16)_label_(2022).svg) | Public domain | — |
| `oflc-r18.svg` | [OFLC Restricted 18 (R18) label (2022).svg](https://commons.wikimedia.org/wiki/File:OFLC_Restricted_18_(R18)_label_(2022).svg) | Public domain | — |

## CSA / Arcom (France), 2002 signage

| File | Source | Licence | Edited |
|---|---|---|---|
| `fr-10.svg` | [Moins10.svg](https://commons.wikimedia.org/wiki/File:Moins10.svg) | Public domain | — |
| `fr-12.svg` | [Moins12.svg](https://commons.wikimedia.org/wiki/File:Moins12.svg) | Public domain | — |
| `fr-16.svg` | [Moins16.svg](https://commons.wikimedia.org/wiki/File:Moins16.svg) | Public domain | — |
| `fr-18.svg` | [Moins18.svg](https://commons.wikimedia.org/wiki/File:Moins18.svg) | Public domain | — |

## IFCO (Ireland), cinema marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `ifco-g.svg` | [IFCO G (Cinema).svg](https://commons.wikimedia.org/wiki/File:IFCO_G_(Cinema).svg) | Public domain | — |
| `ifco-pg.svg` | [IFCO PG (Cinema).svg](https://commons.wikimedia.org/wiki/File:IFCO_PG_(Cinema).svg) | Public domain | — |
| `ifco-12a.svg` | [IFCO 12A.svg](https://commons.wikimedia.org/wiki/File:IFCO_12A.svg) | Public domain | — |
| `ifco-15a.svg` | [IFCO 15A.svg](https://commons.wikimedia.org/wiki/File:IFCO_15A.svg) | Public domain | — |
| `ifco-16.svg` | [IFCO 16 (Cinema).svg](https://commons.wikimedia.org/wiki/File:IFCO_16_(Cinema).svg) | Public domain | — |
| `ifco-18.svg` | [IFCO 18 (Cinema).svg](https://commons.wikimedia.org/wiki/File:IFCO_18_(Cinema).svg) | Public domain | — |

## KAVI (Finland), 2016 marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `fi-s.svg` | [FI-SALLITTU (2016).svg](https://commons.wikimedia.org/wiki/File:FI-SALLITTU_(2016).svg) | Public domain | — |
| `fi-7.svg` | [FI-7 (2016).svg](https://commons.wikimedia.org/wiki/File:FI-7_(2016).svg) | Public domain | — |
| `fi-12.svg` | [FI-12 (2016).svg](https://commons.wikimedia.org/wiki/File:FI-12_(2016).svg) | Public domain | — |
| `fi-16.svg` | [FI-16 (2016).svg](https://commons.wikimedia.org/wiki/File:FI-16_(2016).svg) | Public domain | — |
| `fi-18.svg` | [FI-18 (2016).svg](https://commons.wikimedia.org/wiki/File:FI-18_(2016).svg) | Public domain | — |

## Medieraadet (Denmark), 2021 marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `dk-a.svg` | [Medierådet Tilladt for alle (2021).svg](https://commons.wikimedia.org/wiki/File:Medierådet_Tilladt_for_alle_(2021).svg) | Public domain | — |
| `dk-7.svg` | [Medierådet Tilladt for alle, men frarådes børn under 7 år (2021).svg](https://commons.wikimedia.org/wiki/File:Medierådet_Tilladt_for_alle,_men_frarådes_børn_under_7_år_(2021).svg) | Public domain | — |
| `dk-11.svg` | [Medierådet For ages 11 and up (Tilladt for børn over 11 år) (2021).svg](https://commons.wikimedia.org/wiki/File:Medierådet_For_ages_11_and_up_(Tilladt_for_børn_over_11_år)_(2021).svg) | Public domain | — |
| `dk-15.svg` | [Medierådet For ages 15 and up (Tilladt for børn over 15 år) (2021).svg](https://commons.wikimedia.org/wiki/File:Medierådet_For_ages_15_and_up_(Tilladt_for_børn_over_15_år)_(2021).svg) | Public domain | — |

## ICAA (Spain)

| File | Source | Licence | Edited |
|---|---|---|---|
| `icaa-a.svg` | [ICAA A.svg](https://commons.wikimedia.org/wiki/File:ICAA_A.svg) | Public domain | — |
| `icaa-7.svg` | [ICAA 7.svg](https://commons.wikimedia.org/wiki/File:ICAA_7.svg) | Public domain | — |
| `icaa-12.svg` | [ICAA 12.svg](https://commons.wikimedia.org/wiki/File:ICAA_12.svg) | Public domain | — |
| `icaa-16.svg` | [ICAA 16.svg](https://commons.wikimedia.org/wiki/File:ICAA_16.svg) | Public domain | — |
| `icaa-18.svg` | [ICAA 18.svg](https://commons.wikimedia.org/wiki/File:ICAA_18.svg) | Public domain | — |
| `icaa-x.svg` | [ICAA X.svg](https://commons.wikimedia.org/wiki/File:ICAA_X.svg) | Public domain | — |

## KMRB (South Korea), 2021 marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `kmrb-all.svg` | [KMRB All (2021).svg](https://commons.wikimedia.org/wiki/File:KMRB_All_(2021).svg) | Public domain | — |
| `kmrb-12.svg` | [KMRB 12 (2021).svg](https://commons.wikimedia.org/wiki/File:KMRB_12_(2021).svg) | Public domain | — |
| `kmrb-15.svg` | [KMRB 15 (2021).svg](https://commons.wikimedia.org/wiki/File:KMRB_15_(2021).svg) | Public domain | — |
| `kmrb-19.svg` | [KMRB 19 (2024).svg](https://commons.wikimedia.org/wiki/File:KMRB_19_(2024).svg) | Public domain | — |

## CBFC (India), 2020 marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `cbfc-u.svg` | [CBFC U (2020).svg](https://commons.wikimedia.org/wiki/File:CBFC_U_(2020).svg) | Public domain | — |
| `cbfc-ua.svg` | [CBFC UA (2020).svg](https://commons.wikimedia.org/wiki/File:CBFC_UA_(2020).svg) | Public domain | — |
| `cbfc-a.svg` | [CBFC A (2020).svg](https://commons.wikimedia.org/wiki/File:CBFC_A_(2020).svg) | Public domain | — |

## CHVRS (Canada)

| File | Source | Licence | Edited |
|---|---|---|---|
| `chvrs-g.svg` | [Canadian Film Rating G.svg](https://commons.wikimedia.org/wiki/File:Canadian_Film_Rating_G.svg) | Public domain | — |
| `chvrs-pg.svg` | [Canadian Film Rating PG.svg](https://commons.wikimedia.org/wiki/File:Canadian_Film_Rating_PG.svg) | Public domain | — |
| `chvrs-14a.svg` | [Canadian Film Rating 14A.svg](https://commons.wikimedia.org/wiki/File:Canadian_Film_Rating_14A.svg) | Public domain | — |
| `chvrs-18a.svg` | [Canadian Film Rating 18A.svg](https://commons.wikimedia.org/wiki/File:Canadian_Film_Rating_18A.svg) | Public domain | — |
| `chvrs-r.svg` | [Canadian Film Rating R.svg](https://commons.wikimedia.org/wiki/File:Canadian_Film_Rating_R.svg) | Public domain | — |
| `chvrs-adult.svg` | [Canadian Film Rating A.svg](https://commons.wikimedia.org/wiki/File:Canadian_Film_Rating_A.svg) | Public domain | — |
| `chvrs-e.svg` | [CHVRS E 2014.svg](https://commons.wikimedia.org/wiki/File:CHVRS_E_2014.svg) | Public domain | — |

## Régie du cinéma (Québec)

| File | Source | Licence | Edited |
|---|---|---|---|
| `qc-13.svg` | [Quebec Rating 13.svg](https://commons.wikimedia.org/wiki/File:Quebec_Rating_13.svg) | Public domain | — |
| `qc-16.svg` | [Quebec Rating 16.svg](https://commons.wikimedia.org/wiki/File:Quebec_Rating_16.svg) | Public domain | — |
| `qc-18.svg` | [Quebec Rating 18.svg](https://commons.wikimedia.org/wiki/File:Quebec_Rating_18.svg) | Public domain | — |

## IMDA (Singapore)

| File | Source | Licence | Edited |
|---|---|---|---|
| `imda-g.svg` | [IMDA Age Rating - General Audiences.svg](https://commons.wikimedia.org/wiki/File:IMDA_Age_Rating_-_General_Audiences.svg) | Public domain | — |
| `imda-pg.svg` | [IMDA Age Rating - Parental Guidance.svg](https://commons.wikimedia.org/wiki/File:IMDA_Age_Rating_-_Parental_Guidance.svg) | Public domain | — |
| `imda-pg13.svg` | [IMDA Age Rating - Parental Guidance for Under 13.svg](https://commons.wikimedia.org/wiki/File:IMDA_Age_Rating_-_Parental_Guidance_for_Under_13.svg) | Public domain | — |
| `imda-nc16.svg` | [IMDA Age Rating - No Children Under 16.svg](https://commons.wikimedia.org/wiki/File:IMDA_Age_Rating_-_No_Children_Under_16.svg) | Public domain | — |
| `imda-m18.svg` | [IMDA Age Rating - Mature 18.svg](https://commons.wikimedia.org/wiki/File:IMDA_Age_Rating_-_Mature_18.svg) | Public domain | — |
| `imda-r21.svg` | [IMDA Age Rating - Restricted 21.svg](https://commons.wikimedia.org/wiki/File:IMDA_Age_Rating_-_Restricted_21.svg) | Public domain | — |

## LSF (Indonesia)

| File | Source | Licence | Edited |
|---|---|---|---|
| `lsf-su.svg` | [Lembaga Sensor Film SU.svg](https://commons.wikimedia.org/wiki/File:Lembaga_Sensor_Film_SU.svg) | Public domain | — |
| `lsf-13.svg` | [Lembaga Sensor Film 13+.svg](https://commons.wikimedia.org/wiki/File:Lembaga_Sensor_Film_13+.svg) | Public domain | — |
| `lsf-17.svg` | [Lembaga Sensor Film 17+.svg](https://commons.wikimedia.org/wiki/File:Lembaga_Sensor_Film_17+.svg) | Public domain | — |
| `lsf-21.svg` | [Lembaga Sensor Film 21+.svg](https://commons.wikimedia.org/wiki/File:Lembaga_Sensor_Film_21+.svg) | Public domain | — |

## Thailand

| File | Source | Licence | Edited |
|---|---|---|---|
| `th-g.svg` | [Thai Film Rating - General.svg](https://commons.wikimedia.org/wiki/File:Thai_Film_Rating_-_General.svg) | Public domain | — |
| `th-p.svg` | [Thai Film Rating - Educational.svg](https://commons.wikimedia.org/wiki/File:Thai_Film_Rating_-_Educational.svg) | Public domain | — |
| `th-13.svg` | [Thai Film Rating - PG 13+.svg](https://commons.wikimedia.org/wiki/File:Thai_Film_Rating_-_PG_13+.svg) | Public domain | — |
| `th-15.svg` | [Thai Film Rating - PG 15+.svg](https://commons.wikimedia.org/wiki/File:Thai_Film_Rating_-_PG_15+.svg) | Public domain | — |
| `th-18.svg` | [Thai Film Rating - PG 18+.svg](https://commons.wikimedia.org/wiki/File:Thai_Film_Rating_-_PG_18+.svg) | Public domain | — |
| `th-20.svg` | [Thai Film Rating - Adult Only 20-.svg](https://commons.wikimedia.org/wiki/File:Thai_Film_Rating_-_Adult_Only_20-.svg) | Public domain | — |

## GSRR (Taiwan)

| File | Source | Licence | Edited |
|---|---|---|---|
| `gsrr-g.svg` | [GSRR G logo.svg](https://commons.wikimedia.org/wiki/File:GSRR_G_logo.svg) | Public domain | — |
| `gsrr-p.svg` | [GSRR P logo.svg](https://commons.wikimedia.org/wiki/File:GSRR_P_logo.svg) | Public domain | — |
| `gsrr-pg12.svg` | [GSRR PG 12 logo.svg](https://commons.wikimedia.org/wiki/File:GSRR_PG_12_logo.svg) | Public domain | — |
| `gsrr-pg15.svg` | [GSRR PG 15 logo.svg](https://commons.wikimedia.org/wiki/File:GSRR_PG_15_logo.svg) | Public domain | — |
| `gsrr-r.svg` | [GSRR R logo.svg](https://commons.wikimedia.org/wiki/File:GSRR_R_logo.svg) | Public domain | — |

## TRDSİ (Turkey) — CC0

| File | Source | Licence | Edited |
|---|---|---|---|
| `trdsi-6.svg` | [TRDSİ 6+.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_6+.svg) | Public domain | — |
| `trdsi-6a.svg` | [TRDSİ 6A.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_6A.svg) | Public domain | — |
| `trdsi-10.svg` | [TRDSİ 10+.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_10+.svg) | Public domain | — |
| `trdsi-10a.svg` | [TRDSİ 10A.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_10A.svg) | Public domain | — |
| `trdsi-13.svg` | [TRDSİ 13+.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_13+.svg) | Public domain | — |
| `trdsi-13a.svg` | [TRDSİ 13A.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_13A.svg) | Public domain | — |
| `trdsi-16.svg` | [TRDSİ 16+.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_16+.svg) | Public domain | — |
| `trdsi-18.svg` | [TRDSİ 18+.svg](https://commons.wikimedia.org/wiki/File:TRDSİ_18+.svg) | Public domain | — |

## KFCB (Kenya)

| File | Source | Licence | Edited |
|---|---|---|---|
| `kfcb-ge.svg` | [Kenya Film Classification GE.svg](https://commons.wikimedia.org/wiki/File:Kenya_Film_Classification_GE.svg) | Public domain | — |
| `kfcb-pg.svg` | [Kenya Film Classification PG.svg](https://commons.wikimedia.org/wiki/File:Kenya_Film_Classification_PG.svg) | Public domain | — |
| `kfcb-16.svg` | [Kenya Film Classification 16.svg](https://commons.wikimedia.org/wiki/File:Kenya_Film_Classification_16.svg) | Public domain | — |
| `kfcb-18.svg` | [Kenya Film Classification 18.svg](https://commons.wikimedia.org/wiki/File:Kenya_Film_Classification_18.svg) | Public domain | — |

## NFVCB (Nigeria)

| File | Source | Licence | Edited |
|---|---|---|---|
| `nfvcb-g.svg` | [NFVCB G.svg](https://commons.wikimedia.org/wiki/File:NFVCB_G.svg) | Public domain | — |
| `nfvcb-pg.svg` | [NFVCB PG.svg](https://commons.wikimedia.org/wiki/File:NFVCB_PG.svg) | Public domain | — |
| `nfvcb-12.svg` | [NFVCB 12.svg](https://commons.wikimedia.org/wiki/File:NFVCB_12.svg) | Public domain | — |
| `nfvcb-12a.svg` | [NFVCB 12A.svg](https://commons.wikimedia.org/wiki/File:NFVCB_12A.svg) | Public domain | — |
| `nfvcb-15.svg` | [NFVCB 15.svg](https://commons.wikimedia.org/wiki/File:NFVCB_15.svg) | Public domain | — |
| `nfvcb-18.svg` | [NFVCB 18.svg](https://commons.wikimedia.org/wiki/File:NFVCB_18.svg) | Public domain | — |
| `nfvcb-re.svg` | [NFVCB RE.svg](https://commons.wikimedia.org/wiki/File:NFVCB_RE.svg) | Public domain | — |

## FPB (South Africa), 2024 marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `fpb-a.svg` | [FPB - A - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_A_-_2024.svg) | Public domain | — |
| `fpb-pg.svg` | [FPB - PG - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_PG_-_2024.svg) | Public domain | — |
| `fpb-7-9pg.svg` | [FPB - 7-9 PG - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_7-9_PG_-_2024.svg) | Public domain | — |
| `fpb-10-12pg.svg` | [FPB - 10-12 PG - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_10-12_PG_-_2024.svg) | Public domain | — |
| `fpb-13.svg` | [FPB - 13 - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_13_-_2024.svg) | Public domain | — |
| `fpb-16.svg` | [FPB - 16 - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_16_-_2024.svg) | Public domain | — |
| `fpb-18.svg` | [FPB - 18 - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_18_-_2024.svg) | Public domain | — |
| `fpb-x18.svg` | [FPB - X18 - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_X18_-_2024.svg) | Public domain | — |
| `fpb-xx.svg` | [FPB - XX - 2024.svg](https://commons.wikimedia.org/wiki/File:FPB_-_XX_-_2024.svg) | Public domain | — |

## INCAA (Argentina)

| File | Source | Licence | Edited |
|---|---|---|---|
| `incaa-g.svg` | [INCAA G.svg](https://commons.wikimedia.org/wiki/File:INCAA_G.svg) | Public domain | — |
| `incaa-r13.svg` | [INCAA R-13.svg](https://commons.wikimedia.org/wiki/File:INCAA_R-13.svg) | Public domain | — |
| `incaa-r17.svg` | [INCAA R-17.svg](https://commons.wikimedia.org/wiki/File:INCAA_R-17.svg) | Public domain | — |
| `incaa-c.svg` | [INCAA C 2026.svg](https://commons.wikimedia.org/wiki/File:INCAA_C_2026.svg) | Public domain | — |
| `incaa-sp.svg` | [INCAA SP.svg](https://commons.wikimedia.org/wiki/File:INCAA_SP.svg) | Public domain | — |

## NBC (Maldives)

| File | Source | Licence | Edited |
|---|---|---|---|
| `nbc-g.svg` | [NBC Maldives G rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_G_rating.svg) | Public domain | — |
| `nbc-pu.svg` | [NBC Maldives PU rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_PU_rating.svg) | Public domain | — |
| `nbc-pg.svg` | [NBC Maldives PG rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_PG_rating.svg) | Public domain | — |
| `nbc-12.svg` | [NBC Maldives 12+ rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_12+_rating.svg) | Public domain | — |
| `nbc-15.svg` | [NBC Maldives 15+ rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_15+_rating.svg) | Public domain | — |
| `nbc-18.svg` | [NBC Maldives 18+ rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_18+_rating.svg) | Public domain | — |
| `nbc-18r.svg` | [NBC Maldives 18+R rating.svg](https://commons.wikimedia.org/wiki/File:NBC_Maldives_18+R_rating.svg) | Public domain | — |

## Kuwait

| File | Source | Licence | Edited |
|---|---|---|---|
| `kw-r15.svg` | [Kuwaiti film classification R-15.svg](https://commons.wikimedia.org/wiki/File:Kuwaiti_film_classification_R-15.svg) | Public domain | — |
| `kw-r18.svg` | [Kuwaiti film classification R-18.svg](https://commons.wikimedia.org/wiki/File:Kuwaiti_film_classification_R-18.svg) | Public domain | — |

## RTC (Mexico), 2024 marks

| File | Source | Licence | Edited |
|---|---|---|---|
| `rtc-a.svg` | [RTC Mexico A 2024.svg](https://commons.wikimedia.org/wiki/File:RTC_Mexico_A_2024.svg) | Public domain | — |
| `rtc-aa.svg` | [RTC Mexico AA 2024.svg](https://commons.wikimedia.org/wiki/File:RTC_Mexico_AA_2024.svg) | Public domain | — |
| `rtc-b.svg` | [RTC Mexico B 2024.svg](https://commons.wikimedia.org/wiki/File:RTC_Mexico_B_2024.svg) | Public domain | — |
| `rtc-b15.svg` | [RTC Mexico B15 2024.svg](https://commons.wikimedia.org/wiki/File:RTC_Mexico_B15_2024.svg) | Public domain | — |
| `rtc-c.svg` | [RTC Mexico C 2024.svg](https://commons.wikimedia.org/wiki/File:RTC_Mexico_C_2024.svg) | Public domain | — |
| `rtc-d.svg` | [RTC Mexico D 2024.svg](https://commons.wikimedia.org/wiki/File:RTC_Mexico_D_2024.svg) | Public domain | — |

## Iceland

| File | Source | Licence | Edited |
|---|---|---|---|
| `is-l.svg` | [Icelandic rating L.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_L.svg) | Public domain | — |
| `is-6.svg` | [Icelandic rating 6.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_6.svg) | Public domain | — |
| `is-9.svg` | [Icelandic rating 9.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_9.svg) | Public domain | — |
| `is-12.svg` | [Icelandic rating 12.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_12.svg) | Public domain | — |
| `is-14.svg` | [Icelandic rating 14.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_14.svg) | Public domain | — |
| `is-16.svg` | [Icelandic rating 16.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_16.svg) | Public domain | — |
| `is-18.svg` | [Icelandic rating 18.svg](https://commons.wikimedia.org/wiki/File:Icelandic_rating_18.svg) | Public domain | — |

## Hungary

| File | Source | Licence | Edited |
|---|---|---|---|
| `hu-kn.svg` | [KN icon A (Hungary).svg](https://commons.wikimedia.org/wiki/File:KN_icon_A_(Hungary).svg) | Public domain | — |
| `hu-6.svg` | [6 icon A (Hungary).svg](https://commons.wikimedia.org/wiki/File:6_icon_A_(Hungary).svg) | Public domain | — |
| `hu-12.svg` | [12 icon A (Hungary).svg](https://commons.wikimedia.org/wiki/File:12_icon_A_(Hungary).svg) | Public domain | — |
| `hu-16.svg` | [16 icon A (Hungary).svg](https://commons.wikimedia.org/wiki/File:16_icon_A_(Hungary).svg) | Public domain | — |
| `hu-18.svg` | [18 icon A (Hungary).svg](https://commons.wikimedia.org/wiki/File:18_icon_A_(Hungary).svg) | Public domain | — |
| `hu-x.svg` | [X icon A (Hungary).svg](https://commons.wikimedia.org/wiki/File:X_icon_A_(Hungary).svg) | Public domain | — |

## JSO (Slovakia)

| File | Source | Licence | Edited |
|---|---|---|---|
| `jso-u.svg` | [JSO rating tag U.svg](https://commons.wikimedia.org/wiki/File:JSO_rating_tag_U.svg) | Public domain | — |
| `jso-7.svg` | [JSO´s rating tag 7+.svg](https://commons.wikimedia.org/wiki/File:JSO´s_rating_tag_7+.svg) | Public domain | — |
| `jso-12.svg` | [JSO´s rating tag 12+.svg](https://commons.wikimedia.org/wiki/File:JSO´s_rating_tag_12+.svg) | Public domain | — |
| `jso-15.svg` | [JSO´s rating tag 15+.svg](https://commons.wikimedia.org/wiki/File:JSO´s_rating_tag_15+.svg) | Public domain | — |
| `jso-18.svg` | [JSO´s rating tag 18.svg](https://commons.wikimedia.org/wiki/File:JSO´s_rating_tag_18.svg) | Public domain | — |

## NFA (Ghana)

| File | Source | Licence | Edited |
|---|---|---|---|
| `nfa-u.svg` | [NFA U Rating.svg](https://commons.wikimedia.org/wiki/File:NFA_U_Rating.svg) | Public domain | — |
| `nfa-pg.svg` | [NFA PG Rating.svg](https://commons.wikimedia.org/wiki/File:NFA_PG_Rating.svg) | Public domain | — |
| `nfa-12.svg` | [NFA 12+ Rating.svg](https://commons.wikimedia.org/wiki/File:NFA_12+_Rating.svg) | Public domain | — |
| `nfa-15.svg` | [NFA 15+ Rating.svg](https://commons.wikimedia.org/wiki/File:NFA_15+_Rating.svg) | Public domain | — |
| `nfa-18.svg` | [NFA 18+ Rating.svg](https://commons.wikimedia.org/wiki/File:NFA_18+_Rating.svg) | Public domain | — |
| `nfa-ns.svg` | [NFA NS Rating.svg](https://commons.wikimedia.org/wiki/File:NFA_NS_Rating.svg) | Public domain | — |

Retrieved 16 August 2026.

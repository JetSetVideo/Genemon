# Persona simulation report

Command: `deno task sim 4 1` - 28 days, 12 personas, 128328 ledger rows, 9868 market rounds, run time 22.5 s.

## Players

| persona | style | sessions | play h (plan) | phys h | battles W/L/D | ranked W/L/D | rating (rank) | collection | dex / goal | bred (max gen) | achievements | credits | trades |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Léa Morel (lea) | collector/storyteller | 72 | 24.0 (24.6) | 6.2 | 12/2/0 | 0/0/0 | unrated | 70 | 59 / 150 | 0 (0) | 8 | 3430 | 0 |
| Gérard Fabre (gerard) | explorer/socializer | 161 | 80.6 (82.4) | 47.5 | 46/56/1 | 10/29/0 | 1383 (#9) | 42 | 117 / 120 | 0 (0) | 26 | 10030 | 0 |
| Sophie Morel (sophie) | casual/socializer | 282 | 57.3 (57.6) | 15.6 | 61/81/0 | 26/37/0 | 1469 (#6) | 42 | 37 / 30 | 0 (0) | 25 | 9770 | 0 |
| Max (max) | breeder/explorer | 133 | 158.1 (156.6) | 21.3 | 137/129/0 | 65/93/0 | 1537 (#5) | 188 | 128 / 300 | 28 (28) | 40 | 21530 | 0 |
| Claude (claude) | theorycrafter/completionist | 150 | 424.1 (422.8) | 0.0 | 384/205/0 | 0/0/0 | unrated | 398 | 189 / 1176 | 8 (8) | 46 | 0 | 0 |
| Thomas Nguyen (thomas) | speedrunner/competitor | 187 | 196.4 (201.3) | 13.4 | 239/521/0 | 130/326/0 | 1442 (#8) | 60 | 71 / 84 | 0 (0) | 33 | 14460 | 0 |
| Inès Benali (ines) | competitor/socializer | 165 | 117.1 (114.0) | 27.0 | 524/119/0 | 431/89/0 | 1712 (#1) | 42 | 41 / 40 | 0 (0) | 40 | 17260 | 0 |
| Karim Benali (karim) | trader/territorial | 500 | 133.0 (133.0) | 97.0 | 116/66/0 | 41/49/0 | 1553 (#3) | 95 | 87 / 250 | 0 (0) | 32 | 17180 | 0 |
| Monique Garnier (monique) | storyteller/breeder | 118 | 77.4 (77.4) | 20.3 | 21/23/0 | 9/8/0 | 1550 (#4) | 44 | 60 / 50 | 16 (16) | 16 | 6400 | 0 |
| Camille Dubois (camille) | socializer/collector | 266 | 88.0 (89.0) | 33.0 | 116/108/0 | 46/49/0 | 1694 (#2) | 84 | 95 / 100 | 0 (0) | 28 | 13150 | 0 |
| Lotte Peeters (lotte) | completionist/trader | 156 | 149.2 (148.0) | 38.2 | 62/130/0 | 16/95/0 | 1209 (#10) | 276 | 166 / 1176 | 4 (4) | 40 | 14380 | 0 |
| Yanis Benali (yanis) | territorial/competitor | 294 | 109.6 (109.8) | 44.8 | 194/195/0 | 88/87/0 | 1451 (#7) | 26 | 74 / 70 | 0 (0) | 40 | 18050 | 0 |

## Favourite moves, world and frustrations

| persona | top moves (casts) | declared favourites cast | places | territories (claims/takeovers/lost) | caught (on site) | released | denied physical | companion | frustrations |
|---|---|---|---|---|---|---|---|---|---|
| lea | waterJet 192, seedShot 145, photonDart 129 | 470 | 6 | 0 (0/0/0) | 67 (19) | 0 | 14 | plant L6 hunger 0.25 | physical-gate 14 |
| gerard | steelSpike 723, iceShard 468, seedShot 440 | 471 | 15 | 14 (25/0/0) | 199 (136) | 160 | 22 | plant L10 hunger 0.25 | empty-queue 5, physical-gate 22, skill-mismatch 6 |
| sophie | airCutter 1736, mindSpike 1076, waterJet 1042 | 4007 | 11 | 0 (0/0/0) | 41 (7) | 2 | 11 | air L10 hunger 0.25 | empty-queue 9, physical-gate 11, skill-mismatch 6 |
| max | voidOrb 2255, toxicSpit 2122, sparkBolt 1200 | 1005 | 10 | 4 (4/0/0) | 193 (33) | 36 | 64 | poison L13 hunger 0.25 | empty-queue 14, physical-gate 64, skill-mismatch 12 |
| claude | sparkBolt 4244, thunderBeam 3535, voidOrb 3148 | 3554 | 0 | 0 (0/0/0) | 387 (0) | 0 | 89 | electric L17 hunger 0.25 | physical-gate 89 |
| thomas | airCutter 8759, sparkBolt 7530, photonDart 4975 | 22896 | 9 | 0 (0/0/0) | 90 (8) | 33 | 25 | air L16 hunger 0.25 | empty-queue 196, physical-gate 25, skill-mismatch 166 |
| ines | umbraOrb 7133, cinderSpit 6822, rockToss 4609 | 2412 | 10 | 7 (11/1/0) | 44 (12) | 5 | 11 | fire L17 hunger 0.25 | empty-queue 123, physical-gate 11, skill-mismatch 246 |
| karim | steelSpike 2067, seedShot 1045, voidOrb 839 | 3970 | 12 | 11 (120/0/1) | 124 (102) | 32 | 9 | plant L11 hunger 0.25 | empty-queue 14, physical-gate 9, skill-mismatch 4 |
| monique | mindSpike 401, waterJet 330, prismRay 245 | 63 | 11 | 0 (0/0/0) | 66 (23) | 41 | 18 | water L8 hunger 0.25 | empty-queue 1, physical-gate 18, skill-mismatch 1 |
| camille | umbraOrb 5036, voidOrb 2792, mindSpike 2315 | 2927 | 17 | 4 (4/0/0) | 135 (60) | 54 | 15 | shadow L12 hunger 0.25 | empty-queue 20, physical-gate 15, skill-mismatch 4 |
| lotte | iceShard 3583, steelSpike 1638, toxicSpit 626 | 5818 | 14 | 8 (10/0/0) | 324 (108) | 55 | 77 | ice L12 hunger 0.25 | empty-queue 3, physical-gate 77, skill-mismatch 33 |
| yanis | rockToss 3766, steelSpike 1934, airCutter 1348 | 1138 | 8 | 24 (175/0/0) | 90 (40) | 67 | 10 | earth L15 hunger 0.25 | empty-queue 119, physical-gate 10, skill-mismatch 18 |

## Hours played by hour of day

| persona | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lea | . | . | . | . | . | . | . | . | . | . | 2.8 | 1.4 | . | . | 2.5 | 2.5 | 4.5 | 6.5 | 3.7 | . | . | . | . | . |
| gerard | . | . | . | . | . | . | . | 12.4 | 10.3 | 2.5 | 5.5 | 0.4 | . | . | 14.1 | 14.9 | 2.6 | . | 6.3 | . | 4.7 | 6.8 | . | . |
| sophie | . | . | . | . | . | . | 1.7 | 5.2 | 7.0 | . | 1.0 | 1.4 | 7.9 | 1.6 | 1.0 | 1.6 | 1.1 | 6.1 | 5.3 | 3.1 | . | 11.5 | 1.8 | . |
| max | 10.8 | 1.6 | . | . | . | . | . | . | . | 2.5 | 13.2 | 10.8 | 9.4 | 4.2 | 4.4 | 14.7 | 18.3 | 9.8 | 2.3 | . | 2.5 | 12.4 | 26.0 | 14.9 |
| claude | 21.7 | 27.8 | 26.3 | 25.7 | 27.5 | 22.2 | 4.3 | 22.5 | 7.6 | 6.0 | 17.1 | 24.3 | 21.3 | 17.8 | 17.2 | 22.9 | 23.5 | 16.9 | 3.0 | 4.7 | 17.7 | 25.1 | 17.4 | 3.9 |
| thomas | 21.2 | 24.1 | 5.9 | . | . | . | . | . | 10.2 | 1.4 | 2.7 | 2.1 | 8.9 | 5.8 | 4.5 | 9.6 | 4.7 | 6.6 | 2.1 | . | 17.9 | 25.3 | 24.2 | 19.4 |
| ines | 7.2 | . | . | . | . | . | . | 5.8 | . | . | 0.8 | 2.3 | 14.1 | 3.5 | 2.8 | 6.5 | 8.3 | 6.2 | 0.5 | . | . | 26.0 | 25.9 | 7.4 |
| karim | . | . | . | . | . | 4.8 | 2.4 | 7.8 | 8.2 | 8.7 | 9.3 | 10.6 | 8.8 | 12.4 | 7.5 | 9.7 | 11.1 | 10.4 | 6.0 | . | 6.7 | 8.9 | . | . |
| monique | . | . | . | . | . | . | . | . | 9.5 | 3.6 | 3.9 | 2.6 | 0.7 | . | . | 15.2 | 19.3 | 1.7 | . | . | 5.0 | 15.9 | . | . |
| camille | 5.0 | 2.8 | 5.0 | . | . | . | . | 4.3 | 1.2 | . | 1.2 | 2.5 | 2.5 | . | 1.6 | 4.9 | 12.7 | 7.0 | 2.3 | 2.6 | 7.3 | 10.4 | 9.6 | 5.1 |
| lotte | 5.2 | . | . | . | . | . | . | 5.2 | 5.5 | 1.4 | 6.3 | 8.7 | 7.6 | 5.5 | 3.5 | 11.0 | 11.6 | 7.2 | 3.3 | 0.2 | 16.9 | 22.6 | 21.9 | 5.8 |
| yanis | . | . | . | . | . | . | 0.1 | 4.6 | 1.6 | 8.1 | 11.8 | 6.4 | 5.5 | 4.8 | 2.8 | 5.1 | 14.0 | 7.0 | 13.2 | 7.4 | 17.0 | . | . | . |

## Balance

| style | games | W/L/D | win rate |
|---|---|---|---|
| collector | 14 | 12/2/0 | 86% |
| competitor | 643 | 524/119/0 | 82% |
| theorycrafter | 589 | 384/205/0 | 65% |
| trader | 182 | 116/66/0 | 64% |
| socializer | 224 | 116/108/0 | 52% |
| breeder | 266 | 137/129/0 | 52% |
| territorial | 389 | 194/195/0 | 50% |
| storyteller | 44 | 21/23/0 | 48% |
| explorer | 103 | 46/56/1 | 45% |
| casual | 142 | 61/81/0 | 43% |
| completionist | 192 | 62/130/0 | 32% |
| speedrunner | 760 | 239/521/0 | 31% |

Rated ranked matches 862; battles 2686; draw rate 0%; mean duration 27.3 s.
Rating spread: n=10 min 1208.691 max 1712.238 sd 139.546 IQR 107.921; Spearman(skill, rating) 0.043.
Empty ranked queue by hour: 22 54 15 0 0 4 2 27 35 20 24 24 38 18 14 27 26 33 26 15 21 18 24 17

| element | casts | share |
|---|---|---|
| electric | 21385 | 15% |
| air | 19519 | 13% |
| shadow | 13416 | 9% |
| earth | 12590 | 9% |
| void | 12211 | 8% |
| light | 12031 | 8% |
| fire | 11557 | 8% |
| neutral | 7904 | 5% |
| metal | 7605 | 5% |
| water | 6470 | 4% |
| plant | 6016 | 4% |
| psychic | 5896 | 4% |
| ice | 5143 | 4% |
| poison | 3906 | 3% |

Element usage entropy (1 = perfectly even over 14): 0.957

## World

Places 348, discovered 123; claims 349, takeovers 1, failed raids 0, cells lost while the owner slept 0.
Catches on site 548, virtual 1212; by rarity {"common":1170,"epic":19,"legendary":4,"rare":58,"uncommon":509}.

| element | caught | released |
|---|---|---|
| air | 164 | 65 |
| earth | 227 | 34 |
| electric | 116 | 23 |
| fire | 111 | 25 |
| ice | 86 | 27 |
| light | 85 | 40 |
| metal | 108 | 20 |
| neutral | 142 | 33 |
| plant | 182 | 53 |
| poison | 107 | 21 |
| psychic | 92 | 39 |
| shadow | 156 | 50 |
| void | 41 | 8 |
| water | 143 | 47 |

## Market

Trades 7691 (0 involve a persona), units 26102, credits 763999; open listings 29; wallet Gini 0.219.
Money: opening balances 5500, reward faucet 140140, NPC refills 765462; supply {"wallets":869258,"escrow":18,"treasury":41826,"minted":911102,"withdrawn":0,"balanced":true}.

| item | trades | units | median unit price | list price | median / list |
|---|---|---|---|---|---|
| food.candy | 390 | 2161 | 1.6 | 2 | 0.8 |
| food.greens | 397 | 2133 | 2.375 | 3 | 0.792 |
| food.fish | 301 | 1696 | 5.8 | 8 | 0.725 |
| food.minerals | 283 | 1535 | 4 | 6 | 0.667 |
| food.coffeeBean | 281 | 1527 | 3.333 | 5 | 0.667 |
| food.spicyPepper | 264 | 1511 | 3.286 | 5 | 0.657 |
| food.meat | 256 | 1418 | 6.143 | 9 | 0.683 |
| food.honey | 263 | 1379 | 5 | 7 | 0.714 |
| food.berries | 243 | 1357 | 2.5 | 4 | 0.625 |
| food.seaweed | 255 | 1355 | 3.3 | 5 | 0.66 |
| food.mushroom | 246 | 1322 | 4.05 | 6 | 0.675 |
| food.iceCream | 227 | 1288 | 2.6 | 4 | 0.65 |
| food.glowFruit | 131 | 722 | 9.5 | 14 | 0.679 |
| food.ashRoot | 109 | 606 | 10.667 | 16 | 0.667 |
| cosmetic.glowPaint | 482 | 482 | 113 | 90 | 1.256 |

## Ledger rows by kind

| what | rows |
|---|---|
| battle.reaction | 19736 |
| market.post | 17288 |
| battle.ko | 12535 |
| genemon.experience | 9980 |
| market.npc.round | 9868 |
| market.expired | 9568 |
| market.buyout | 5554 |
| sim.action | 4037 |
| market.bid | 3560 |
| market.give | 3452 |
| market.company.restock | 3290 |
| battle.end | 2686 |
| battle.settled | 2686 |
| battle.start | 2686 |
| sim.session.end | 2484 |
| sim.session.start | 2484 |
| market.sold | 2137 |
| genemon.feed | 1904 |
| genemon.catch | 1760 |
| virtual.travel | 1755 |
| market.deposit | 1512 |
| sim.frustration | 1365 |
| battle.weather | 1085 |
| genemon.exposure | 977 |
| world.visit | 977 |
| ladder.match | 862 |
| world.catch | 548 |
| genemon.release | 485 |
| world.release | 485 |
| territory.reinforce | 276 |

# expand-gemini measurement (MEASUREMENT ONLY, agent/expand-gemini-cm)

Questions: bench/expand-gemini/questions.jsonl (Gemini, written after expansions in bc69e67). Gate fixed in advance: off = shipped row, w03/w05 = ceec087 row (bar x1.3, strong 2, gap 1.05). Raw runs: scratchpad gemini/runs (not committed). Reproduce: node bench/expand-gemini/run.mjs <n> <dir>/<off|w03|w05>-<n>.json (MEM_EXPAND=1 MEM_EXPAND_WEIGHT=0.3|0.5), then node bench/expand-gemini/score.mjs <dir> 1000,10000,100000.

## Validation

```
counts { everyday: 81, technical: 40, 'decoy-far': 60, 'decoy-near': 60 } distinct targets 81 gold 84 filler 37 german 6
missing expected ids: 0 []
lines without an expected field (read as []): 120 bad shape: 0 duplicate queries: []
decoys breaking the definition: far 23/60, near 27/60
  L124 decoy-far shared=[rule,point] What are the primary rules for scoring points in Gaelic football?
  L126 decoy-far shared=[three] What is the best itinerary for visiting Kyoto temples in three days?
  L127 decoy-far shared=[need,serv] Why do red wines need to breathe before being served with dinner?
  L132 decoy-far shared=[run] What are the typical symptoms of iron deficiency anemia in marathon runners?
  L135 decoy-far shared=[one] How should one properly prune tomato plants for maximum fruit yield?
  L137 decoy-far shared=[current] How do marine iguanas adapt to swimming in cold ocean currents?
  L141 decoy-far shared=[human,system,without] How does the human lymphatic system circulate fluids without a dedicated heart pump?
  L142 decoy-far shared=[migr] What is the migration route of monarch butterflies through North America?
  L143 decoy-far shared=[survive] How do alpine plants survive sub-zero temperatures under heavy snow?
  L146 decoy-far shared=[creat] What geological forces created the Grand Canyon over millions of years?
  L148 decoy-far shared=[show] What are the main differences between classical dressage and western show jumping?
  L150 decoy-far shared=[used] What materials were traditionally used to construct Viking longships?
  L154 decoy-far shared=[human,first] What are the main stages of human embryonic development during the first trimester?
  L155 decoy-far shared=[build] How do coral reefs build their calcium carbonate exoskeletons?
  L159 decoy-far shared=[build] How did ancient Roman engineers build durable aqueducts across valleys?
  L162 decoy-far shared=[new] What are the courtship displays of birds of paradise in New Guinea?
  L165 decoy-far shared=[prevent] How do desert reptiles prevent water loss through their skin?
  L166 decoy-far shared=[key] What are the key differences between espresso roast and blonde roast beans?
  L168 decoy-far shared=[behind,print] What is the history behind the invention of the printing press by Gutenberg?
  L169 decoy-far shared=[back] How do sea turtles navigate back to their natal beaches to lay eggs?
  L172 decoy-far shared=[rule] What are the fundamental rules of curling in the Winter Olympics?
  L175 decoy-far shared=[track] How do bats use echolocation to track flying insects in total darkness?
  L177 decoy-far shared=[shap] How do glaciers carve U-shaped valleys across mountainous terrain?
  L182 decoy-near shared=[] How much cash should a traveler exchange before visiting a foreign country?
  L183 decoy-near shared=[crash,near] What caused the train crash near the central railway junction?
  L184 decoy-near shared=[library,backup,fail] Why did the city library backup generator fail during the hurricane?
  L185 decoy-near shared=[expir,library,card,local] How do you renew an expired library card at the local municipal branch?
  L186 decoy-near shared=[long,queue,roll] What was the longest queue at the amusement park roller coaster yesterday?
  L187 decoy-near shared=[run,two,second,track] Can an athlete run two hundred meters under twenty seconds in track competitions?
  L189 decoy-near shared=[contain,ship] How many wooden storage containers fit inside a standard shipping vessel?
  L191 decoy-near shared=[page,index,contain,back] How many pages does the average index section contain at the back of a cookbook?
  L193 decoy-near shared=[jobs,take,test] Which federal jobs require applicants to take a physical fitness test?
  L194 decoy-near shared=[team,first,time] What is the proper etiquette when meeting a business team for the first time?
  L197 decoy-near shared=[someone,lock,writ] How can someone become a locked room puzzle mystery writer?
  L198 decoy-near shared=[track,mail] How do you track incoming international parcel mail that has no barcode?
  L201 decoy-near shared=[canary,work] What did the canary bird traditionally signify to miners working underground?
  L203 decoy-near shared=[owner,lost,found] Who is the rightful owner of lost treasure found on public beaches?
  L204 decoy-near shared=[long,audit,take] How long does a tax audit investigation typically take for small businesses?
  L206 decoy-near shared=[someone,duty] What happens if someone ignores their jury duty summons letter?
  L213 decoy-near shared=[minute,im] Wie viele Kopien druckt ein moderner Drucker pro Minute im Buero?
  L214 decoy-near shared=[scan,fuer] Welche Software wird beim Scanner fuer alte Familienfotos empfohlen?
  L215 decoy-near shared=[long,checkout,take] How long does the checkout procedure take when returning a rental vehicle?
  L216 decoy-near shared=[old,load] What causes an old brick load bearing wall to develop structural cracks?
  L225 decoy-near shared=[event,docs] What historical event does this museum tour guide docs describe?
  L227 decoy-near shared=[bill,invoice] What is the proper way to dispute an incorrect medical billing invoice?
  L230 decoy-near shared=[team,deploy] How does a mountaineering team deploy safety ropes along a narrow ridge?
  L231 decoy-near shared=[upload,stream] What is the ideal upload speed for streaming high definition video?
  L238 decoy-near shared=[retry,three] What happens to the retry count when a baseball pitcher throws three balls?
  L240 decoy-near shared=[restore,found] How do archaeologists restore ancient Roman pottery pieces found in ruins?
  L241 decoy-near shared=[] What causes a bicycle chain to slip off its gear cogs during sprints?
word reuse, Gemini:
  everyday/gold        q=42 words=319 in target note 9.1% only in target expansion 21.3% questions with no note word 19
  everyday/de          q=3 words=33 in target note 30.3% only in target expansion 0% questions with no note word 0
  everyday/filler      q=36 words=297 in target note 24.6% only in target expansion 20.2% questions with no note word 8
  technical/gold       q=36 words=349 in target note 9.7% only in target expansion 10% questions with no note word 16
  technical/de         q=3 words=37 in target note 8.1% only in target expansion 2.7% questions with no note word 1
  technical/filler     q=1 words=11 in target note 45.5% only in target expansion 0% questions with no note word 0
  everyday+technical   q=121 words=1046 in target note 14.7% only in target expansion 15.7% questions with no note word 44
word reuse, self-written (expand-fair):
  everyday/gold        q=40 words=188 in target note 16.5% only in target expansion 28.7% questions with no note word 16
  everyday/filler      q=40 words=347 in target note 18.2% only in target expansion 41.8% questions with no note word 0
  technical/gold       q=30 words=147 in target note 21.1% only in target expansion 39.5% questions with no note word 7
  technical/filler     q=10 words=83 in target note 43.4% only in target expansion 27.7% questions with no note word 0
  keywords/gold        q=20 words=76 in target note 100% only in target expansion 0% questions with no note word 0
  keywords/filler      q=20 words=133 in target note 100% only in target expansion 0% questions with no note word 0
  everyday+technical   q=120 words=765 in target note 21% only in target expansion 36.6% questions with no note word 23
```

## Results

| metric (n) | off 1k | w03 1k | w05 1k | off 10k | w03 10k | w05 10k | off 100k | w03 100k | w05 100k |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| everyday @3 (81) | 38.3 | 59.3 | 59.3 | 37.0 | 50.6 | 49.4 | 33.3 | 44.4 | 45.7 |
| everyday @10 (81) | 45.7 | 64.2 | 63.0 | 40.7 | 55.6 | 55.6 | 37.0 | 49.4 | 49.4 |
|   gold targets (en) @3 (42) | 35.7 | 61.9 | 61.9 | 35.7 | 64.3 | 61.9 | 35.7 | 59.5 | 59.5 |
|   filler targets (s*) @3 (36) | 38.9 | 55.6 | 55.6 | 36.1 | 33.3 | 33.3 | 27.8 | 25.0 | 27.8 |
|   filler targets (s*) @3, strict id (36) | 36.1 | 52.8 | 52.8 | 36.1 | 30.6 | 30.6 | 25.0 | 25.0 | 25.0 |
| technical @3 (40) | 45.0 | 52.5 | 52.5 | 45.0 | 55.0 | 57.5 | 45.0 | 52.5 | 57.5 |
| technical @10 (40) | 45.0 | 57.5 | 55.0 | 47.5 | 57.5 | 60.0 | 47.5 | 55.0 | 60.0 |
|   gold targets (en) @3 (36) | 44.4 | 52.8 | 52.8 | 44.4 | 55.6 | 58.3 | 44.4 | 52.8 | 58.3 |
|   filler targets (s*) @3 (1) | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| German g-de-* (ev+tech) @3 (6) | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 |
| German g-de-* (ev+tech) @10 (6) | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 |
| decoy far FP (all 60) (60) | 33.3 | 30.0 | 31.7 | 31.7 | 26.7 | 30.0 | 30.0 | 25.0 | 28.3 |
| decoy near FP (all 60) (60) | 58.3 | 55.0 | 55.0 | 58.3 | 58.3 | 60.0 | 56.7 | 56.7 | 56.7 |
| decoy far FP (clean) (37) | 13.5 | 16.2 | 16.2 | 13.5 | 10.8 | 16.2 | 10.8 | 8.1 | 16.2 |
| decoy near FP (clean) (33) | 57.6 | 54.5 | 51.5 | 57.6 | 54.5 | 54.5 | 54.5 | 51.5 | 51.5 |
| unknown answers | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Same expansion runs under the SHIPPED gate (no recalibration), for reference:
| everyday @3 | 38.3 | 60.5 | 60.5 | 37.0 | 50.6 | 50.6 | 33.3 | 45.7 | 50.6 |
| technical @3 | 45.0 | 55.0 | 55.0 | 45.0 | 55.0 | 57.5 | 45.0 | 52.5 | 57.5 |
| German g-de-* (ev+tech) @3 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 | 50.0 |
| decoy far FP (all 60) | 33.3 | 35.0 | 36.7 | 31.7 | 30.0 | 35.0 | 30.0 | 28.3 | 33.3 |
| decoy near FP (all 60) | 58.3 | 63.3 | 61.7 | 58.3 | 65.0 | 63.3 | 56.7 | 65.0 | 63.3 |

Paired vs off at the same size (everyday+technical @3, lenient filler): won / lost, exact McNemar p
  w03 1k: questions won 22, lost 2, p=0.000036; decoys newly FP 7, no longer FP 11, p=0.48
  w05 1k: questions won 23, lost 3, p=0.000088; decoys newly FP 9, no longer FP 12, p=0.66
  w03 10k: questions won 18, lost 3, p=0.0015; decoys newly FP 6, no longer FP 9, p=0.61
  w05 10k: questions won 18, lost 3, p=0.0015; decoys newly FP 9, no longer FP 9, p=1.0
  w03 100k: questions won 15, lost 3, p=0.0075; decoys newly FP 7, no longer FP 10, p=0.63
  w05 100k: questions won 18, lost 3, p=0.0015; decoys newly FP 12, no longer FP 13, p=1.0

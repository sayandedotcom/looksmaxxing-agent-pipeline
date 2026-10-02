# Failure log (raw notes, written as things broke)

## F1: fake PMIDs passed the "exists" check (found before any LLM run)
- Symptom: `getAbstract('99999999')` returned `{title:'', abstract:''}` instead of null.
- Cause: existence check was `xml.includes('<PubmedArticle')`, and NCBI wraps even empty results in `<PubmedArticleSet>`, so it always matched.
- Why it mattered: combined with an empty quote (`''.includes('')` is true), a made-up citation would pass both code checks and go to the judge.
- Fix: regex `/<PubmedArticle[\s>]/`, plus quotes must be ≥20 normalized chars.

## Run 1: "does mewing actually change your jawline" (all green: 7/7 claims kept, editor pass, published)
A green run that was still wrong. Found by reading the trace and article, not from any error.

### F2: unverified facts rode through the "verified" channel
- The article says bone smashing "risks fractures, nerve damage, tooth damage and infection" and "adult facial bones have largely finished growing". Neither is in any cited abstract.
- Cause: the Brief schema had a `safetyNotes` field. Step 2 only verified `claims`, but the writer got the whole brief under the heading "VERIFIED RESEARCH". The editor also treated the notes as part of the brief, so it called them supported.
- A schema field I added for safety turned into a route around verification.

### F3: absence-of-evidence claims can't be checked by quote matching
- Claim c1: "no controlled trial shows mewing reshapes adult jaws". Its "evidence" was a quote about social-media sentiment from a TikTok-analysis paper. Code saw a real PMID and a real quote; the judge said "backs" because the paper does call the claims pseudoscientific.
- In the article that PMID ended up under the "There's no trial" paragraph, so the citation looks like it supports the absence claim.
- The researcher's process narration also leaked in: the article says "I searched for... Nothing came back."
- Cause: "nothing found" has no quote to check. The only real evidence for it is the search log, which step 2 never looked at.

### F4: editor said "pass" while listing an issue, and the issue shipped
- The editor flagged "it's the whole basis for the tongue-shapes-bone story" as overstated, then returned verdict "pass". The sentence is in the published article.
- Cause: I let the model's `verdict` field decide, and my prompt only made unsupported/bad_citation/harm block. The model followed that literally.

### F5: "partial" support kept the whole claim
- The judge marked c6 (bone smashing) "partial" and noted the abstract has no injury data. The claim was kept word for word, including the injury list, and the caveat went to the writer only as a soft note.
- Cause: "partial" meant "keep, plus a note", when it should mean "keep only the part that's backed".

## Run 2: same topic, after F2–F5 fixes → HELD after 3 editor rounds
The fixes worked:
- c1 ("no study shows mewing reshapes adult jaws") now has no padding citation, just 5 search receipts. All 5 searches were confirmed in the log.
- 3 of 7 claims were narrowed by the judge. c4 lost its "tongue follows bone" interpretation, which no source states.
- The editor now flags facts that only appear in advice. The verdict is computed in code.

### F6: editor drip-fed issues, so the loop couldn't converge
- Rounds flagged 2 → 2 → 1 issues, all different. It looked like the writer adding new problems each revision.
- Checked the data instead: all 5 flagged sentences were already in draft 0. Revisions left 51/54 and 47/53 sentences unchanged, so the writer did exactly what it was told.
- The real cause: the editor reports roughly the 2 worst issues per pass, not all of them. With MAX_ROUNDS=3, any draft with more than about 5 problems gets held, however fixable.
- Raising MAX_ROUNDS would only hide it and spend more tokens.
- Fix: make coverage structural. Code splits the draft into numbered sentences, and the editor must return a ruling for every one, naming the claim id it rests on, or advice, or not_factual. Code rejects a review that skips sentences. Excerpts now come from code, not the model.
- Bonus: code can check that a sentence's [PMID] belongs to the claim the editor says it rests on (catches F3-style misplaced citations without the model).
- Side note: the researcher still put soft facts in advice ("mewing is unlikely to be a big risk", "better track record"). The editor caught them, but at the cost of a revision round.

## Run 3: after F6 fix → HELD again, for a different reason
- Coverage fixed: the editor ruled on 65/65 sentences every round (31 claim-backed, 9 advice, 25 not factual).
- Issues per round: 4 → 2 → 1. Round 1's four were good catches: "probably harmless" (no source says so), and "nobody has run the trial" (we only know we didn't *find* one).

### F7: the editor contradicts itself on unchanged text
- Round 2 flagged 2 sentences that round 1 had ruled OK, word for word identical in drafts 0 and 1. Round 3 flagged a sentence that rounds 1 and 2 both passed and that was in all 3 drafts.
- So this isn't missed coverage any more; it's an inconsistent judge. Borderline sentences flip between passes, and every fresh full review is another roll of the dice. With 65 sentences, some will flip almost every round.
- Round 3's catch was pedantic ("orthodontics is treatment that's been studied", flagged because the brief has no source for it). A human editor would let that through.
- Fix: make rulings stick. Rulings are stored by sentence text. Unchanged sentences keep their previous ruling and aren't sent again; only new or edited sentences get reviewed. Every sentence still gets a full ruling once (F6 coverage), and the loop can now converge, because the set under review only shrinks.
- Trade-off I'm accepting: if round 1 misses something in an unchanged sentence, it stays missed. That's how a human copy edit works too: you don't re-litigate paragraphs you already signed off on.

## Run 4: after F7 fix → PUBLISHED (round 1, 0 issues, 56/56 sentences ruled)
- Honest article, and every sentence maps to a claim, advice, or not_factual.

### Known limitation, deliberately not fixed: research depth varies between runs
- Run 1: 20 tool calls, 7 claims. Run 4: 13 tool calls, 3 claims (the schema minimum). Run 4 lost good material earlier runs found (Cochrane on myofunctional therapy for sleep apnea, the palate-expansion "direction" study).
- The obvious fix is to raise the minimum claim count. That's exactly what caused F3: the researcher padded the evidence slot with an unrelated paper. On a topic with little evidence, forcing a count brings padding back.
- What I'd do with more time: a coverage check between steps 1 and 2. A cheap model lists the sub-questions a reader would have, and the researcher gets one more pass only if a sub-question has no claim *and* no search receipt. That asks for more searching, not more claims.
- Small thing: the article reads out all 7 search queries in one sentence. It's honest but clunky. A footnote would be better.

## Runs 5–6: finasteride → PUBLISHED (round 1). Gum/jawline → PUBLISHED (rounds 4 → 1 → 0 issues; rounds 2–3 re-reviewed only 4 and 1 edited sentences)

### F8: one stance meant two things, and the verifier dropped the best evidence
- Gum topic, c1: "a 6-month RCT in adults found gum did not change masseter thickness or jaw shape". The researcher labeled it `not_supported` and attached search receipts, not the RCT.
- The judge then saw that the search results include an RCT testing exactly this, ruled "does_not_back", and the claim was cut. That was the strongest finding on the topic. It only reached the article because c3 also mentioned it.
- Cause: `not_supported` was ambiguous between "tested, no effect" and "never tested". The F3 fix gave search receipts to that stance, so the researcher used receipts for a null result.
- Fix: split it into `tested_no_effect` (cite the study) and `untested` (search receipts only).

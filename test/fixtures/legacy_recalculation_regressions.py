"""Isolated recalculation behavior; no browser, provider or real worker calls."""
import importlib.util, json, tempfile, unittest, hashlib
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("recalc",Path(__file__).resolve().parents[2]/"scripts/atelier/recalculate-legacy.py")
recalc=importlib.util.module_from_spec(spec);spec.loader.exec_module(recalc)

class RecalculationRegression(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.base=self.root/".omx/atelier/legacy-recalculation"
        self.art=self.base/"artifacts"/("a"*64);self.art.mkdir(parents=True)
        self.job={"id":"a"*64,"domain":"glsl","files":{}}
        for name in ("source.txt","playable.html"):
            (self.art/name).write_text("original "+name)
            self.job["files"][name]={"sha256":hashlib.sha256((self.art/name).read_bytes()).hexdigest()}
        self.card={"artifact":str(self.art),"domain":"glsl","scoreScale":10,"scoringContract":recalc.CONTRACT,
                   "ensemble":dict.fromkeys("DARN",3),"judges":[{"vendor":v,"axes":dict.fromkeys("DARN",n)} for v,n in (("judge-a",2),("judge-b",4))],"level":"F","scoredAt":"2026-09-08T00:00:00Z"}
    def test_original_changes_reject_before_evaluation(self):
        (self.art/"source.txt").write_text("changed")
        with self.assertRaises(ValueError):recalc.verify_inputs(self.base,self.job)
    def test_contract_judges_and_arithmetic_are_required(self):
        for change in ({"scoreScale":5},{"scoringContract":"legacy"},{"judges":[self.card["judges"][0]]},{"ensemble":dict.fromkeys("DARN",8)}):
            with self.subTest(change=change),self.assertRaises(ValueError):recalc.verify_card(self.job,self.art,{**self.card,**change})
    def test_publish_and_resume_preserve_originals_and_append_once(self):
        legacy=self.root/".omx/atelier/scorecards/old.json";legacy.parent.mkdir(parents=True);legacy.write_text("original score")
        raw=json.dumps(self.card).encode()
        a=recalc.publish(self.root,self.base,self.job,raw);b=recalc.publish(self.root,self.base,self.job,raw)
        self.assertEqual(a["scorecardSha256"],b["scorecardSha256"])
        self.assertEqual(legacy.read_text(),"original score")
        self.assertEqual(len((self.root/".omx/atelier/lessons/trend.jsonl").read_text().splitlines()),1)
        self.assertEqual((self.art/"source.txt").read_text(),"original source.txt")
    def test_existing_different_result_is_never_overwritten(self):
        recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
        with self.assertRaises(ValueError):recalc.publish(self.root,self.base,self.job,json.dumps({**self.card,"level":"different"}).encode())
    def test_receipt_failure_does_not_report_completion_and_resume_deduplicates(self):
        raw=json.dumps(self.card).encode()
        with patch.object(recalc,"atomic_json",side_effect=OSError("receipt unavailable")),self.assertRaises(OSError):recalc.publish(self.root,self.base,self.job,raw)
        recalc.publish(self.root,self.base,self.job,raw)
        self.assertEqual(len((self.root/".omx/atelier/lessons/trend.jsonl").read_text().splitlines()),1)
    def test_completed_job_resumes_without_a_provider_call(self):
        recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
        def forbidden(*args,**kwargs):self.fail("completed work called scorer")
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden),"already-published")
    def test_operator_hold_prevents_new_child(self):
        (self.root/".omx/atelier/operator-admission-hold.json").write_text("{}")
        def forbidden(*args,**kwargs):self.fail("held work called scorer")
        with self.assertRaises(RuntimeError):recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden)
    def test_provider_failure_is_batch_blocking_not_artwork_completion(self):
        from types import SimpleNamespace
        with self.assertRaises(recalc.ProviderBlocked):recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,lambda *a,**kw:SimpleNamespace(returncode=4))
        self.assertFalse((self.base/"receipts"/(self.job["id"]+".json")).exists())
    def test_crash_after_score_creation_recovers_without_rejudging(self):
        run=self.base/"jobs"/self.job["id"];cards=run/".omx/atelier/scorecards";cards.mkdir(parents=True)
        recalc.atomic_json(run/"input.json",{"contract":recalc.CONTRACT,"domain":"glsl","hashes":{n:v["sha256"] for n,v in self.job["files"].items()}})
        (cards/"score.json").write_text(json.dumps(self.card))
        def forbidden(*args,**kwargs):self.fail("retained result called scorer")
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden),"published")
    def test_batch_stops_on_provider_failure_before_second_artwork(self):
        other={**self.job,"id":"b"*64}
        plan=self.root/"plan.json";plan.write_text(json.dumps({"schema":"sinter.legacy-rescore-plan/1","contract":recalc.CONTRACT,"jobs":[self.job,other]}))
        with patch.object(recalc,"process_job",side_effect=recalc.ProviderBlocked("quota")) as call:
            state=recalc.run_batch(self.root,plan,Path("/fake/node"),2,60)
        self.assertEqual(call.call_count,1);self.assertEqual(state["published"],0)
        self.assertEqual(state["status"],"blocked-providers")
    def test_second_batch_cannot_take_the_same_slot(self):
        import fcntl
        plan=self.root/"plan.json";plan.write_text(json.dumps({"schema":"sinter.legacy-rescore-plan/1","contract":recalc.CONTRACT,"jobs":[]}))
        self.base.mkdir(parents=True,exist_ok=True)
        with (self.base/"batch.lock").open("a") as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(RuntimeError):recalc.run_batch(self.root,plan,Path("/fake/node"),1,60)
    def test_partial_existing_trend_never_swallows_a_new_event(self):
        trend=self.root/".omx/atelier/lessons/trend.jsonl";trend.parent.mkdir(parents=True);trend.write_text('{"unfinished":')
        with self.assertRaises(ValueError):recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
        self.assertEqual(trend.read_text(),'{"unfinished":')
    def test_matching_filename_with_conflicting_event_is_not_completion(self):
        recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
        trend=self.root/".omx/atelier/lessons/trend.jsonl";r=json.loads(trend.read_text());r["axes"]="D=9 A=9 R=9 N=9";trend.write_text(json.dumps(r)+"\n")
        with self.assertRaises(ValueError):recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
    def test_completed_receipt_resume_never_credits_missing_or_conflicting_trend_evidence(self):
        trend=self.root/".omx/atelier/lessons/trend.jsonl"
        recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
        def forbidden(*args,**kwargs):self.fail("resume called scorer")
        trend.unlink()
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden),"already-published")
        self.assertEqual(len(trend.read_text().splitlines()),1)
        row=json.loads(trend.read_text());row["judges"]=["judge-x","judge-y"];trend.write_text(json.dumps(row)+"\n")
        with self.assertRaises(ValueError):recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden)
    def test_resume_accepts_normal_pilot_event_with_suffixed_axes_and_later_ts(self):
        recalc.publish(self.root,self.base,self.job,json.dumps(self.card).encode())
        trend=self.root/".omx/atelier/lessons/trend.jsonl"
        row=json.loads(trend.read_text())
        row["axes"]="D=3 A=3 R=3 N=3 | judges=2 defects=0";row["ts"]="2026-09-08T00:00:05Z";row["extra"]={"renderMs":412}
        trend.write_text(json.dumps(row)+"\n")
        def forbidden(*args,**kwargs):self.fail("verified pilot resume called scorer")
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden),"already-published")
        self.assertEqual(len(trend.read_text().splitlines()),1)
    def judge_script(self,calls,steps):
        """Scorer mock: each step is (exit_code, insufficient_judges_line|None); rc 0 writes a valid card."""
        from types import SimpleNamespace
        def evaluate(args,cwd,env,stdout,stderr):
            calls.append(cwd);step=steps[len(calls)-1] if len(calls)<=len(steps) else self.fail("unexpected extra scorer call")
            if step[1]:stdout.write(step[1]+"\n");stdout.flush()
            if step[0]==0:
                cards=Path(cwd)/".omx/atelier/scorecards";cards.mkdir(parents=True,exist_ok=True)
                (cards/"score.json").write_text(json.dumps(self.card))
            return SimpleNamespace(returncode=step[0])
        return evaluate
    def fresh_run(self):
        import shutil;shutil.rmtree(self.base/"jobs"/self.job["id"],ignore_errors=True)
    def test_parse_failure_gets_exactly_one_retry_then_publishes(self):
        calls=[]
        evaluate=self.judge_script(calls,[(4,"SSS_SCORE_INSUFFICIENT_JUDGES: glm:parse,evaluator:duplicate_lane"),(0,None)])
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,evaluate),"published")
        self.assertEqual(len(calls),2)
        run=self.base/"jobs"/self.job["id"]
        self.assertIn("glm:parse",(run/"score-attempt-1.log").read_text())
        self.assertTrue((run/"score-attempt-2.log").exists(),"old attempt log must survive the retry")
    def test_second_parse_failure_stops_with_evidence_and_restart_buys_nothing(self):
        calls=[]
        evaluate=self.judge_script(calls,[(4,"SSS_SCORE_INSUFFICIENT_JUDGES: glm:empty"),(4,"SSS_SCORE_INSUFFICIENT_JUDGES: glm:parse")])
        with self.assertRaises(recalc.ProviderBlocked) as stopped:
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,evaluate)
        self.assertEqual(len(calls),2)
        self.assertIn("score-attempt-2.log",str(stopped.exception))
        self.assertIn("glm:empty",(self.base/"jobs"/self.job["id"]/"score-attempt-1.log").read_text())
        self.assertIn("glm:parse",(self.base/"jobs"/self.job["id"]/"score-attempt-2.log").read_text())
        def forbidden(*args,**kwargs):self.fail("restart bought an extra scorer attempt")
        with self.assertRaises(RuntimeError):
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden)
        self.assertEqual(len(calls),2)
    def test_completed_parse_failure_can_resume_its_single_retry(self):
        calls=[]
        first=self.judge_script(calls,[(4,"SSS_SCORE_INSUFFICIENT_JUDGES: glm:parse")])
        with self.assertRaises(RuntimeError):
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,first,deadline=__import__("time").monotonic()+20)
        resumed=[]
        second=self.judge_script(resumed,[(0,None)])
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,second),"published")
        self.assertEqual((len(calls),len(resumed)),(1,1))
    def test_restart_never_retries_completed_non_parse_failure(self):
        cases=["glm:http_429","glm:http_500","glm:transport","glm:runtime","unknown",None]
        for failure in cases:
            with self.subTest(failure=failure):
                self.fresh_run();calls=[]
                with self.assertRaises(recalc.ProviderBlocked):
                    line="SSS_SCORE_INSUFFICIENT_JUDGES: "+failure if failure else None
                    recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,
                                       self.judge_script(calls,[(4,line)]))
                with self.assertRaises(recalc.ProviderBlocked):
                    recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,
                                       lambda *a,**kw:self.fail("restart retried non-parse failure"))
                self.assertEqual(len(calls),1)
    def test_restart_never_retries_started_or_malformed_attempt_state(self):
        run=self.base/"jobs"/self.job["id"]
        cases=[
            {"count":1,"reasons":["attempt-1 started"]},
            {"count":1,"reasons":[]},
            {"count":True,"reasons":["attempt-1 started"]},
            {"count":1,"reasons":[{"rc":4}]},
            {"count":1,"reasons":["rc=4:glm:parse"],"extra":True},
        ]
        for index,state in enumerate(cases):
            with self.subTest(state=state):
                self.fresh_run();run.mkdir(parents=True,exist_ok=True)
                recalc.atomic_json(run/"attempts.json",state)
                exception=RuntimeError if index==0 else ValueError
                with self.assertRaises(exception):
                    recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,
                                       lambda *a,**kw:self.fail("invalid state called scorer"))
    def test_completed_state_must_match_retained_log(self):
        run=self.base/"jobs"/self.job["id"];run.mkdir(parents=True,exist_ok=True)
        (run/"score-attempt-1.log").write_text("SSS_SCORE_INSUFFICIENT_JUDGES: glm:http_429\n")
        recalc.atomic_json(run/"attempts.json",{"count":1,"reasons":["rc=4:glm:parse"]})
        with self.assertRaises(ValueError):
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,
                               lambda *a,**kw:self.fail("contradictory state called scorer"))
    def test_non_parse_judge_failures_are_never_retried(self):
        import shutil
        cases=["SSS_SCORE_INSUFFICIENT_JUDGES: glm:http_429",
               "SSS_SCORE_INSUFFICIENT_JUDGES: glm:transport",
               "SSS_SCORE_INSUFFICIENT_JUDGES: evaluator:identity,glm:parse",
               "SSS_SCORE_INSUFFICIENT_JUDGES: unknown",
               "SSS_SCORE_INSUFFICIENT_JUDGES: glm:parse,minimax:timeout"]
        for i,line in enumerate(cases):
            with self.subTest(line=line):
                shutil.rmtree(self.base/"jobs"/self.job["id"],ignore_errors=True)
                calls=[]
                evaluate=self.judge_script(calls,[(4,line)])
                with self.assertRaises(recalc.ProviderBlocked):
                    recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,evaluate)
                self.assertEqual(len(calls),1,"non-parse/unknown failures must not be retried")
    def test_operator_hold_appearing_mid_attempt_prevents_second_call(self):
        calls=[]
        def evaluate(args,cwd,env,stdout,stderr):
            from types import SimpleNamespace
            calls.append(cwd);(self.root/".omx/atelier/operator-admission-hold.json").write_text("{}")
            stdout.write("SSS_SCORE_INSUFFICIENT_JUDGES: glm:parse\n");stdout.flush()
            return SimpleNamespace(returncode=4)
        with self.assertRaises(RuntimeError) as held:
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,evaluate)
        self.assertEqual(len(calls),1)
        self.assertIn("operator hold",str(held.exception))
    def test_parse_retry_obeys_remaining_wallclock_budget(self):
        import time
        calls=[]
        evaluate=self.judge_script(calls,[(4,"SSS_SCORE_INSUFFICIENT_JUDGES: glm:parse")])
        with self.assertRaises(RuntimeError) as refused:
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,evaluate,deadline=time.monotonic()+20)
        self.assertEqual(len(calls),1)
        self.assertIn("wallclock",str(refused.exception))
        attempts=json.loads((self.base/"jobs"/self.job["id"]/"attempts.json").read_text())
        self.assertEqual(attempts["count"],1)
    def test_failed_receipt_write_does_not_readmit_scoring(self):
        calls=[]
        real=recalc.atomic_json
        def flaky(path,value):
            if path.name==self.job["id"]+".json":raise OSError("receipt unavailable")
            return real(path,value)
        with patch.object(recalc,"atomic_json",side_effect=flaky),self.assertRaises(OSError):
            recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,self.judge_script(calls,[(0,None)]))
        def forbidden(*args,**kwargs):self.fail("failed receipt write readmitted scoring")
        self.assertEqual(recalc.process_job(self.root,self.base,self.job,Path("/fake/node"),30,forbidden),"published")
        self.assertEqual(len(calls),1)

if __name__=="__main__":unittest.main()

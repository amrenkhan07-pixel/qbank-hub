"""No-write source/payload contract checks; pass the local audit samples JSON."""
import hashlib,json,sys,unittest
from prepladder_import import canonical_payload,stable_json

class MediaContract(unittest.TestCase):
    def test_current_payload_hashes_and_future_references(self):
        samples=json.load(open(sys.argv[1]))
        expected={'846680':'91158caa55261791742896c3ffc94f98b64b26cd4d5187d9f1e68e1cde27e0fb',
            '846685':'e06ffaaa2c7ff87ffbfd429afe160a8f85276bd17c485aadb556a4875d50c930',
            '895286':'8b81e2398357aae0afdc673bbb9ce445415f6d5d3d34b50028b51851f74218d5',
            '855904':'abdae4ef7da3bbe766d42e0dbf479dad752602e222c80854f36fb290cdb8deda',
            'MF5127':'048e9b243d0071dac8bd7c1c9c02f1676bcb5c791aa251cdc318165f21866362',
            'MF5170':'774f5d2e48972604231458f70779f29230b104ba142a65e20fe7ba08528d06a1'}
        for item in samples.values():
            payload=canonical_payload(item['question'])
            self.assertEqual(payload,item['payload'])
            if item['source_question_id'] in expected:
                self.assertEqual(hashlib.sha256(stable_json(payload).encode()).hexdigest(),expected[item['source_question_id']])
            for placement,field in [('question','question_images'),('explanation','explanation_images')]:
                self.assertEqual([m['reference'] for m in payload['media'] if m['placement']==placement],item['question'].get(field,[]))
        q={'id':'future-fixture','text':'<p>Before</p><img src="https://example.com/a.png"><p>After</p>',
           'explanation':'<p>One</p><img data-src="https://example.com/b.png"><p>Two</p>',
           'options':[{'label':'A','text':'A','correct':True}],
           'question_images':['https://example.com/c.png'],'explanation_images':['https://example.com/d.png','https://example.com/e.png']}
        p=canonical_payload(q)
        self.assertEqual(p['question_html'],q['text']);self.assertEqual(p['explanation_html'],q['explanation'])
        self.assertEqual([m['position'] for m in p['media'] if m['placement']=='explanation'],[0,1])

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(MediaContract)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())

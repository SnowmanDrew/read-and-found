import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'index.html').read_text()
CSS=(ROOT/'styles.css').read_text()
EXTRA=(ROOT/'refinements-v26.css').read_text()
JS=(ROOT/'app.js').read_text()
WORKER=(ROOT/'worker/index.js').read_text()
ADAPTER=(ROOT/'api/_adapter.js').read_text()

class RegressionTests(unittest.TestCase):
    def test_home_mobile(self):
        self.assertIn('Good taste is',HTML)
        self.assertIn('Fill with an example',HTML)
        self.assertIn('The Hunger Games',HTML)
        self.assertIn('Normal People',HTML)
        self.assertIn('Agatha Christie',HTML)
        self.assertNotIn('THE READING ROOM',HTML)
        self.assertNotIn('READ & FOUND / BOOKS ARE PERSONAL',HTML)
        self.assertIn('refinements-v26.css',HTML)
        self.assertIn('refinements-v26.js',HTML)
    def test_about(self):
        self.assertIn('for good, not evil (or profit)',HTML)
        self.assertIn('less electricity',HTML)
        self.assertIn('estimated to consume less water',HTML)
        self.assertIn('Books are',HTML)
    def test_backend(self):
        self.assertIn("import worker from '../worker/index.js'",ADAPTER)
        self.assertNotIn('_adapter_original.js',ADAPTER)
        self.assertIn('OPENAI_API_KEY',WORKER)
    def test_source(self):
        self.assertGreater(len(JS),30000)
        self.assertGreater(len(CSS)+len(EXTRA),40000)

if __name__=='__main__':
    unittest.main()

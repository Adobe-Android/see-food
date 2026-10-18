import base64
import json
import threading
import unittest
from urllib import error, request
from unittest.mock import patch

from src.server import AppError, classify, make_server, model_status, parse_decision, validate_image

IMAGE = 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8\xfftest\xff\xd9').decode()
DECISION = {'answers': {'food': {'choice': 'hotdog', 'probabilities': {'hotdog': 0.9, 'not_hotdog': 0.1}}}}


class ValidationTests(unittest.TestCase):
    def test_valid_image(self):
        self.assertEqual(validate_image({'image': IMAGE}), IMAGE)

    def test_bad_images(self):
        for payload in (None, {}, {'image': 1}, {'image': 'data:image/jpeg;base64,!!!'},
                        {'image': 'data:image/png;base64,AAAA'},
                        {'image': 'data:image/jpeg;base64,dGVzdA=='},
                        {'image': 'data:image/jpeg;base64,' + base64.b64encode(b'x' * (2 * 1024 * 1024 + 1)).decode()}):
            with self.subTest(payload_type=type(payload)), self.assertRaises(AppError):
                validate_image(payload)

    def test_decision(self):
        self.assertEqual(parse_decision(DECISION), {'label': 'hotdog', 'probability': 0.9})
        other = {'answers': {'food': {'choice': 'not_hotdog', 'probabilities': {'hotdog': 0.02, 'not_hotdog': 0.98}}}}
        self.assertEqual(parse_decision(other)['label'], 'not_hotdog')

    def test_invalid_decisions_are_not_negative_verdicts(self):
        for payload in ({}, None, {'answers': {'food': {'choice': 'maybe'}}},
                        {'answers': {'food': {'choice': 'hotdog', 'probabilities': {'hotdog': float('nan'), 'not_hotdog': 0}}}}):
            with self.subTest(payload=payload), self.assertRaises(AppError):
                parse_decision(payload)

    @patch('src.server.request.build_opener')
    def test_offline_model(self, opener):
        opener.return_value.open.side_effect = error.URLError('offline')
        with self.assertRaises(AppError) as raised:
            classify(IMAGE, 'http://localhost:1234', 'd1-3b', '')
        self.assertEqual(raised.exception.status, 503)

    def test_cloud_url_not_allowed(self):
        with self.assertRaises(ValueError):
            make_server('127.0.0.1', 0, 'https://example.com', 'd1-3b')


class StatusTests(unittest.TestCase):
    @patch('src.server.request.build_opener')
    def test_readiness_metadata(self, opener):
        entry = {'key': 'd1-3b', 'type': 'decision', 'has_vision_adapter': True,
                 'loaded_instances': [{'id': 'custom-id'}]}
        response = opener.return_value.open.return_value.__enter__.return_value
        for change, expected in (({}, 'ready'), ({'loaded_instances': []}, 'offline'),
                                 ({'has_vision_adapter': False}, 'offline'),
                                 ({'type': 'llm'}, 'offline')):
            response.read.return_value = json.dumps({'models': [{**entry, **change}]}).encode()
            self.assertEqual(model_status('http://localhost:1234', 'd1-3b', '')['state'], expected)
        response.read.return_value = json.dumps({'models': [entry]}).encode()
        self.assertEqual(model_status('http://localhost:1234', 'custom-id', '')['state'], 'ready')
        self.assertEqual(model_status('http://localhost:1234', 'missing', '')['state'], 'offline')

    @patch('src.server.request.build_opener')
    def test_status_failures(self, opener):
        response = opener.return_value.open.return_value.__enter__.return_value
        for payload in (b'bad json', b'{}', b'{"models": null}'):
            response.read.return_value = payload
            self.assertEqual(model_status('http://localhost:1234', 'd1-3b', '')['state'], 'offline')
        opener.return_value.open.side_effect = error.URLError('offline')
        self.assertEqual(model_status('http://localhost:1234', 'd1-3b', '')['state'], 'offline')


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server('127.0.0.1', 0, 'http://localhost:1234', 'd1-3b')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.client = request.build_opener(request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def post(self, payload, headers=None):
        req = request.Request(self.url + '/api/classify', data=json.dumps(payload).encode(),
                              headers=headers or {'Content-Type': 'application/json'})
        try:
            with self.client.open(req) as response:
                return response.status, json.load(response)
        except error.HTTPError as exc:
            with exc:
                return exc.code, json.load(exc)

    def test_static_allowlist(self):
        with self.client.open(self.url) as response:
            self.assertEqual(response.status, 200)
        with self.assertRaises(error.HTTPError) as raised:
            self.client.open(self.url + '/server.py')
        self.assertEqual(raised.exception.code, 404)
        raised.exception.close()

    @patch('src.server.classify', return_value={'label': 'hotdog', 'probability': 0.9, 'model': 'd1-3b'})
    def test_classification_route(self, model):
        status, payload = self.post({'image': IMAGE})
        self.assertEqual(status, 200)
        self.assertEqual(payload['label'], 'hotdog')
        model.assert_called_once()

    @patch('src.server.classify')
    def test_invalid_upload_never_reaches_model(self, model):
        self.assertEqual(self.post({'image': 'invalid'})[0], 400)
        model.assert_not_called()

    def test_cross_origin_blocked(self):
        self.assertEqual(self.post({'image': IMAGE}, {'Content-Type': 'application/json', 'Origin': 'http://example.com'})[0], 403)

    def test_untrusted_host_blocked(self):
        self.assertEqual(self.post({'image': IMAGE}, {'Content-Type': 'application/json', 'Host': 'example.com'})[0], 403)

    @patch('src.server.model_status', return_value={'state': 'ready', 'message': 'Ready'})
    def test_status_route(self, status):
        with self.client.open(self.url + '/api/status') as response:
            self.assertEqual(json.load(response)['state'], 'ready')
        self.server.inference_lock.acquire()
        try:
            with self.client.open(self.url + '/api/status') as response:
                self.assertEqual(json.load(response)['state'], 'busy')
        finally:
            self.server.inference_lock.release()

    def test_busy(self):
        self.server.inference_lock.acquire()
        try:
            self.assertEqual(self.post({'image': IMAGE})[0], 429)
        finally:
            self.server.inference_lock.release()


if __name__ == '__main__':
    unittest.main()

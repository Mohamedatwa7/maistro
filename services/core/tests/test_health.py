from fastapi.testclient import TestClient

from maistro import __version__
from maistro.app import create_app


def test_health() -> None:
    client = TestClient(create_app())
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "maistro-core"
    assert body["version"] == __version__

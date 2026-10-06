"""FastAPI transport boundary for BoMesh.

Routers translate HTTP to a service call and back. Application logic lives in
``bomesh.services``; configuration lives in ``config``; shared clients are
built by ``bomesh.runtime``.
"""

"""RAG benchmark harness for BoMesh retrieval and the grounded agent.

The harness drives the real composition (``AppRuntime``): the hybrid index,
``ItemKnowledgeRetriever`` and the agent loop. It never re-implements
retrieval. Design and metric definitions: ``backend/docs_design/evaluation.md``.
"""

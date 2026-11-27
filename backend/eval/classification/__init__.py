"""Classification evaluation: the facet classifier against a labeled set.

``python -m eval classify --suite <name> --workspace <code>`` runs the CLASSIFYING
step (rules, candidates, the configured model, calibration and routing) on every
labeled sample of ``eval/classification/<suite>/labels.jsonl`` against the
workspace's published taxonomy, and reports precision and recall per scheme,
metadata accuracy and a threshold calibration table. Design:
``backend/docs_design/evaluation.md`` "Classification".
"""

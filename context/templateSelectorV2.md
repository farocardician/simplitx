Make the PDF → JSON pipeline run from a simple config file, and wire the **homepage dropdown** so selecting an option loads the right config.

### Config example (unchanged)

```json
{
  "document": { "type": "invoice", "vendor": "PT Simon", "version": "1.3" },
  "stages": [
    { "script": "s01_tokenizer.py" },
    { "script": "s02_normalizer.py" },
    { "script": "s03_segmenter.py", "config": "simon_segmenter_configV3.json" },
    { "script": "s04_camelot_grid_configV12.py", "config": "invoice_simon_min.json" },
    { "script": "s05_normalize_cells.py", "config": "invoice_simon_min.json" },
    { "script": "s06_line_items_from_cells.py", "config": "invoice_stage6_simon.json" },
    { "script": "s07_extractorV2.py", "config": "invoice_simon_min.json" },
    { "script": "s08_validator.py" },
    { "script": "s09_confidence.py" },
    { "script": "s10_parser.py" }
  ]
}
```

---

## A. Backend: pipeline runner (config-driven)

1. Read config, loop `stages[]` in order, call the known scripts with their standard flags and derived input/output paths.
2. If a stage has `"config"`, use it.

**Outputs:** same JSON artifacts and final manifest as current flow

## B. Backend: expose config options for the dropdown

Add a small helper to list configs and build human-readable labels from the config content.

1. Label rule: `label = f"{document.type} {document.vendor} {document.version}"`.

## C. Frontend: dropdown wiring (simple)

1. On page load, fetch `/configs` and populate the dropdown with `option.label`, store `option.file` as the value.
2. When the user selects an option, run the whole pdf2json pipeline using its sets of configuration.


## D. Minimal checks

* Selecting “Invoice PT Simon V1.3” runs using that config and produces the expected final JSON (and XML after that. do not change JSON2XML flow at all).
* We can add new vendors/versions by dropping new config JSON files only—no code edits.

# Presence + Databricks

The synthetic notebook has been run in Databricks and its output is included as demo-results.json. This is a manual export/import integration, not a live connection.

1. Create your Databricks workspace and compute.
2. Import attendance_insights.py as a Python source notebook.
3. Upload synthetic-attendance.csv to a Unity Catalog volume you can write to. Alternatively export finalized attendance from the Attendance insights link in Presence.
4. Set input_path and output_path notebook widgets to your volume paths; run all cells.
5. Download attendance-insights.json from the volume and load it on the Presence insights page.
6. Show the actual Databricks notebook run alongside the app results. Imported report provenance is not independently verified by the app.

Notebook validates rows, rejects contradictory duplicates, removes exact duplicates, then computes class attendance/late rates and daily UTC summaries. Suggestions are descriptive rules, not predictions. Synthetic data is clearly labeled: 1,080 fictional rows across 3 classes and 12 sessions each. No real attendance claims.

Live export uses HMAC pseudonymous student IDs, not guaranteed anonymous IDs. No names, photos or embeddings. Configure ATTENDANCE_ANALYTICS_KEY server-side for stable pseudonyms across restarts; otherwise they change. Only finalized past sessions, maximum 10,000 rows, with staff role and class-manager authorization. Dashboard JSON stays browser-local. No database migrations changed.

Docs: https://docs.databricks.com/aws/en/notebooks/notebook-export-import and https://docs.databricks.com/aws/en/query/formats/csv


The results panel appears at the bottom of attendance, team camera, flight scenario, and the dedicated insights page. It starts blank on every page load. Choose File and import demo-results.json for the recorded synthetic demo, or import a new Databricks JSON output. Reports are no longer auto-loaded or retained in browser storage. All pages display attendance metrics, not flight metrics or recognition accuracy.

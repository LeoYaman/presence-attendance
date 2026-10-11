# Presence + Databricks

The synthetic notebook has been run in Databricks and its output is included as demo-results.json. This is a manual export/import integration, not a live connection.

1. Create your Databricks workspace and compute.
2. Import attendance_insights.py as a Python source notebook.
3. Upload synthetic-attendance.csv to a Unity Catalog volume you can write to. Alternatively export finalized attendance from the Attendance insights link in Presence.
4. Set input_path and output_path notebook widgets to your volume paths; run all cells.
5. Download attendance-insights.json from the volume and load it on the Presence insights page.
6. Show the actual Databricks notebook run alongside the app results. Imported report provenance is not independently verified by the app.

Notebook validates rows, rejects contradictory duplicates, removes exact duplicates, then computes class attendance/late rates and daily UTC summaries. Suggestions are descriptive rules, not predictions. Synthetic data is clearly labeled: 1,080 fictional rows across 3 classes and 12 sessions each. No real attendance claims.

Live export uses HMAC pseudonymous student IDs, not guaranteed anonymous IDs. No names, photos or embeddings. Configure ATTENDANCE_ANALYTICS_KEY server-side for stable pseudonyms across restarts; otherwise they change. Only finalized past sessions, maximum 10,000 rows, with staff role and class-manager authorization. Synthetic provenance comes from an explicit record flag when present; otherwise existing synthetic seed audit entries and the established synthetic/fictional group metadata are used. Camera demo configuration does not determine attendance provenance. Other imported synthetic datasets must retain an explicit row flag or the documented group markers. Dashboard JSON stays browser-local. No database migrations changed.

Docs: https://docs.databricks.com/aws/en/notebooks/notebook-export-import and https://docs.databricks.com/aws/en/query/formats/csv


The attendance insights panel starts blank. The dedicated insights page offers a report selector for finalized Presence Attendance sessions and the bundled synthetic Databricks demo. Session reports refresh about every 10 seconds for authenticated teachers and admins and after session approval/finalization in the current page. You can also download the bundled JSON or import another Databricks Spark JSON report. Imported file provenance is not independently verified. The panel displays attendance metrics, not flight metrics or recognition accuracy.

The finalized-session selector reads `GET /api/attendance-insights/reports`, then requests the selected report from `GET /api/attendance-insights/reports/:uuid`. A Presence Attendance report identifies the source class and session, generation time, local display timezone, and the session's synthetic flag. A zero-record session is valid and reports zero rates. The report is a snapshot from Presence Attendance; selecting it does not submit data to Databricks or run a Databricks job. The Databricks demo option reads the bundled `databricks/demo-results.json` artifact. Manual Databricks Spark file import and the separate pseudonymous CSV export remain available.

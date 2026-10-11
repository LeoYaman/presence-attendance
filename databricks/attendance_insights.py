# Databricks notebook source
# MAGIC %md
# MAGIC # Presence attendance insights
# MAGIC Upload the CSV into a Unity Catalog volume, then set its path below.
# MAGIC Synthetic history is labeled; live data contains pseudonymous IDs, never photos/names.
# COMMAND ----------
import json
from datetime import datetime, timezone
from pyspark.sql import functions as F

# Timestamp parsing and daily buckets must not depend on workspace defaults.
spark.conf.set("spark.sql.session.timeZone", "UTC")

dbutils.widgets.text("input_path", "/Volumes/workspace/default/presence/synthetic-attendance.csv")
dbutils.widgets.text("output_path", "/Volumes/workspace/default/presence/attendance-insights.json")
source=spark.read.option("header",True).csv(dbutils.widgets.get("input_path"))
required={"class_code","session_id","student_key","starts_at","checked_in_at","status","synthetic"}
assert required.issubset(source.columns), "Input columns are missing"
assert source.count() <= 100000, "Keep this demo export below 100,000 rows"
valid=source.withColumn("start",F.to_timestamp("starts_at")).withColumn("checkin",F.to_timestamp("checked_in_at"))
invalid=valid.filter(F.col("start").isNull() | F.col("status").isNull() | ~F.col("status").isin("present","late","absent") | F.col("synthetic").isNull() | ~F.col("synthetic").isin("true","false") | F.col("class_code").isNull() | F.col("session_id").isNull() | F.col("student_key").isNull() | (F.col("status").isin("present","late") & F.col("checkin").isNull()))
assert invalid.count()==0, "Invalid rows: fix them before calculating insights"
# Reject contradictory duplicates; exact retries can safely be dropped.
keys=["class_code","session_id","student_key"]
assert valid.groupBy(*keys).agg(F.countDistinct(F.struct("status","starts_at","checked_in_at","synthetic")).alias("versions")).filter("versions>1").count()==0, "Conflicting duplicate records"
clean=valid.dropDuplicates(keys).withColumn("day",F.date_format("start","yyyy-MM-dd"))
summary=clean.groupBy("class_code").agg(F.count("*").alias("total"),F.sum(F.when(F.col("status").isin("present","late"),1).otherwise(0)).alias("attended"),F.sum(F.when(F.col("status")=="late",1).otherwise(0)).alias("late"),F.sum(F.when(F.col("status")=="absent",1).otherwise(0)).alias("absent"))
daily=clean.groupBy("class_code","day").agg(F.count("*").alias("total"),F.sum(F.when(F.col("status").isin("present","late"),1).otherwise(0)).alias("attended"),F.sum(F.when(F.col("status")=="late",1).otherwise(0)).alias("late"))
display(summary)
display(daily.orderBy("class_code","day"))
classes=[r.asDict() for r in summary.orderBy("class_code").collect()]
for item in classes:
 item["attendance_rate"]=round(item["attended"]/item["total"]*100,1)
 item["late_rate"]=round(item["late"]/item["total"]*100,1)
 item["suggestion"]="Review class start-time or check-in arrangements." if item["late_rate"]>=20 else "Continue monitoring aggregate attendance trends."
result={"version":1,"engine":"Databricks Spark","generated_at":datetime.now(timezone.utc).isoformat(),"synthetic":clean.filter("synthetic = 'true'").count()>0,"quality":{"input_rows":source.count(),"clean_rows":clean.count(),"duplicates_removed":source.count()-clean.count()},"classes":classes,"daily":[r.asDict() for r in daily.orderBy("class_code","day").collect()]}
dbutils.fs.put(dbutils.widgets.get("output_path"),json.dumps(result),overwrite=True)
print("Download attendance-insights.json from the volume, then import it in Presence Attendance insights.")

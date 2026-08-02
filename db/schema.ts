import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const records = sqliteTable("body_records", {
  ownerId: text("owner_id").notNull(),
  date: text("date").notNull(),
  weight: real("weight").notNull(),
  fat: real("fat"),
  bmi: real("bmi"),
  muscle: real("muscle"),
  fasting: integer("fasting", { mode: "boolean" }).notNull(),
  metricsJson: text("metrics_json"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.ownerId, table.date] })]);

export const photos = sqliteTable("body_photos", {
  ownerId: text("owner_id").notNull(),
  date: text("date").notNull(),
  angle: text("angle").notNull(),
  objectKey: text("object_key").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.ownerId, table.date, table.angle] })]);

export const aiCoachProfiles = sqliteTable("ai_coach_profiles", {
  ownerId: text("owner_id").primaryKey(),
  sourceDate: text("source_date"),
  model: text("model").notNull(),
  resultJson: text("result_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

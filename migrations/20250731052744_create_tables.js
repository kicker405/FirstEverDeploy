exports.up = function (knex) {
  return knex.schema
    .createTable("users", (table) => {
      table.increments("userId").primary();
      table.string("userName").notNull().unique();
      table.integer("userPassword").notNull();
    })
    .createTable("sessions", (table) => {
      table.string("sessionId").primary();
      table.integer("userId").unsigned().notNullable();

      table.foreign("userId").references("userId").inTable("users");
    })
    .createTable("timer", (table) => {
      table.string("timerId").primary();
      table.string("timerDescription", 255);
      table.boolean("isActive").notNullable().defaultTo(false);
      table.timestamp("timerStart");
      table.timestamp("timerEnd");
      table.string("timerProcess", 255);
      table.integer("userId").unsigned().notNullable();

      table.foreign("userId").references("userId").inTable("users");
    });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("timer").dropTableIfExists("sessions").dropTableIfExists("users");
};

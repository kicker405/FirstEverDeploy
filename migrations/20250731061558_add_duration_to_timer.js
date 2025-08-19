exports.up = function (knex) {
  return knex.schema.table("timer", (table) => {
    table.string("duration");
  });
};

exports.down = function (knex) {
  return knex.schema.table("timer", (table) => {
    table.dropColumn("duration");
  });
};

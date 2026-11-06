exports.up = function (knex) {
    return knex.schema.createTable("monitor_notification_state", (table) => {
        table.integer("monitor_id").unsigned().primary().references("id").inTable("monitor").onDelete("CASCADE");
        table.integer("status").nullable();
        table.boolean("incident_open").notNullable().defaultTo(false);
        table.boolean("deferred").notNullable().defaultTo(false);
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("monitor_notification_state");
};

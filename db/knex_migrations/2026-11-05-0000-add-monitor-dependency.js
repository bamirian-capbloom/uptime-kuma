exports.up = function (knex) {
    return knex.schema.alterTable("monitor", (table) => {
        table
            .integer("dependency_monitor_id")
            .unsigned()
            .nullable()
            .references("id")
            .inTable("monitor")
            .onDelete("SET NULL")
            .onUpdate("CASCADE");
        table.index("dependency_monitor_id");
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", (table) => {
        table.dropForeign("dependency_monitor_id");
        table.dropIndex("dependency_monitor_id");
        table.dropColumn("dependency_monitor_id");
    });
};

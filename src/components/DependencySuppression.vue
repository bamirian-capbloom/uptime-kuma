<template>
    <span v-if="blocker" class="dependency-suppression">
        <span
            class="badge rounded-pill bg-warning text-dark suppression-label"
            role="note"
            tabindex="0"
            :aria-label="explanation"
            :title="explanation"
            @mouseenter="showTooltip"
            @mouseleave="visible = false"
            @focus="showTooltip"
            @blur="visible = false"
            @keydown.esc="visible = false"
        >
            {{ $t("dependencyAlertsSuppressed") }}
        </span>
        <Tooltip v-if="visible" :content="{}" :x="x" :y="y">
            <span role="tooltip" class="suppression-explanation">{{ explanation }}</span>
        </Tooltip>
    </span>
</template>

<script>
import Tooltip from "./Tooltip.vue";

export default {
    components: { Tooltip },
    props: {
        /** Authenticated monitor ID; never used on public status pages. */
        monitorId: { type: Number, required: true },
    },
    data() {
        return { visible: false, x: 0, y: 0 };
    },
    computed: {
        blocker() {
            if (!this.$root.socket.connected) {
                return null;
            }
            const observation = this.$root.dependencyObservations[this.monitorId];
            return observation ? this.$root.monitorList[observation.blockerId] : null;
        },
        explanation() {
            return this.$t("dependencySuppressionExplanation", { monitor: this.blocker?.name });
        },
    },
    methods: {
        /**
         * Position the shared tooltip within the viewport for hover and keyboard focus.
         * @param {Event} event Focus or mouse event
         * @returns {void}
         */
        showTooltip(event) {
            const rect = event.currentTarget.getBoundingClientRect();
            this.x = Math.max(150, Math.min(window.innerWidth - 150, rect.left + rect.width / 2));
            this.y = rect.bottom + 8;
            this.visible = true;
        },
    },
};
</script>

<style scoped>
.dependency-suppression {
    display: inline-block;
    max-width: 100%;
    white-space: normal;
}

.suppression-label {
    white-space: normal;
    text-align: start;
}

.suppression-label:focus-visible {
    outline: 2px solid currentcolor;
    outline-offset: 2px;
}

.suppression-explanation {
    display: block;
    max-width: min(260px, calc(100vw - 48px));
    color: #f3f4f6;
    white-space: normal;
    overflow-wrap: anywhere;
}
</style>

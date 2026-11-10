import { UP } from "./util";
import type { DependencyBeat, SuppressionObservation } from "./monitor-dependency";

type ToastId = string | number;
type Observations = Record<number, SuppressionObservation>;

interface DownToast {
    error(message: string, options: { timeout: number | false; onClose: () => void }): ToastId;
    dismiss(id: ToastId): void;
}

/** Tracks only monitor DOWN toasts, leaving all other toast lifecycles alone. */
export class DependencyDownToasts {
    private readonly visible = new Map<number, Set<ToastId>>();

    /**
     * @param toast Existing dashboard toast interface
     */
    constructor(private readonly toast: DownToast) {}

    /**
     * Show an accepted, unsuppressed DOWN event with the existing timeout.
     * @param monitorId Monitor receiving the event
     * @param beat Incoming event
     * @param current Newest accepted observation, if online
     * @param observations Current dependency suppression
     * @param message Original DOWN message
     * @param timeout Original error timeout
     * @returns {void}
     */
    show(
        monitorId: number,
        beat: DependencyBeat,
        current: DependencyBeat | undefined,
        observations: Observations,
        message: string,
        timeout: number | false
    ): void {
        if (observations[monitorId] || (current && current !== beat)) {
            return;
        }
        const ids = this.visible.get(monitorId) ?? new Set<ToastId>();
        const id = this.toast.error(message, {
            timeout,
            onClose: () => {
                ids.delete(id);
                if (ids.size === 0 && this.visible.get(monitorId) === ids) {
                    this.visible.delete(monitorId);
                }
            },
        });
        ids.add(id);
        this.visible.set(monitorId, ids);
    }

    /**
     * Dismiss only DOWN toasts whose monitors are suppressed or confirmed UP.
     * @param observations Current dependency suppression
     * @param beats Newest accepted observations from the current connection
     * @returns {void}
     */
    reconcile(observations: Observations, beats: Record<number, DependencyBeat> = {}): void {
        for (const monitorId of this.visible.keys()) {
            if (!observations[monitorId] && beats[monitorId]?.status !== UP) {
                continue;
            }
            const ids = this.visible.get(monitorId);
            this.visible.delete(monitorId);
            for (const id of ids ?? []) {
                this.toast.dismiss(id);
            }
        }
    }
}

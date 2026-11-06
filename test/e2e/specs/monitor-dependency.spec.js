import { expect, test } from "../fixtures";
import { login, restoreSqliteSnapshot, screenshot } from "../util-test";

/**
 * Add a push monitor using the real form.
 * @param {import('@playwright/test').Page} page Browser page
 * @param {string} name Monitor name
 * @param {string|null} dependency Dependency ID
 * @returns {Promise<{id: string, url: string}>} Monitor ID and push endpoint
 */
async function addPushMonitor(page, name, dependency = null) {
    await page.getByRole("link", { name: "Add New Monitor" }).click();
    await page.getByTestId("monitor-type-select").selectOption("push");
    await page.getByTestId("friendly-name-input").fill(name);
    if (dependency) {
        await page.getByLabel("Monitor Dependency", { exact: true }).selectOption(dependency);
    }
    const url = await page.locator("#push-url").inputValue();
    await page.getByTestId("save-button").click();
    await page.waitForURL(/\/dashboard\/\d+$/);
    return { id: page.url().split("/").pop(), url };
}

/**
 * Send a real push heartbeat through the backend notification gate.
 * @param {import('@playwright/test').APIRequestContext} request Request client
 * @param {string} endpoint Push URL
 * @param {string} status UP or DOWN status
 * @returns {Promise<void>}
 */
async function push(request, endpoint, status) {
    const url = new URL(endpoint);
    url.searchParams.set("status", status);
    const response = await request.get(url.toString());
    expect((await response.json()).ok).toBe(true);
}

test.beforeEach(async ({ page }) => {
    await restoreSqliteSnapshot();
    await page.goto("./dashboard");
    await login(page);
});

test("persists dependencies, excludes self and cycles, and clears to None", async ({ page }) => {
    const gateway = await addPushMonitor(page, "Dependency Gateway");
    const service = await addPushMonitor(page, "Dependent Service", gateway.id);
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    const selector = page.getByLabel("Monitor Dependency", { exact: true });
    await expect(selector).toHaveValue(gateway.id);
    await expect(selector.locator(`option[value="${service.id}"]`)).toHaveCount(0);
    await page.goto(`./edit/${gateway.id}`);
    await expect(page.getByTestId("friendly-name-input")).toHaveValue("Dependency Gateway");
    await expect(selector).toHaveValue("None");
    await expect(selector.locator(`option[value="${gateway.id}"]`)).toHaveCount(0);
    await expect(selector.locator(`option[value="${service.id}"]`)).toHaveCount(0);
    await page.goto(`./edit/${service.id}`);
    await expect(page.getByTestId("friendly-name-input")).toHaveValue("Dependent Service");
    await expect(selector).toHaveValue(gateway.id);
    await selector.selectOption({ label: "None" });
    await page.getByTestId("save-button").click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(selector).toHaveValue("None");
});

test("shows backend suppression while preserving DOWN, clears stale state and supports keyboard/mobile/dark mode", async ({
    page,
    request,
}, testInfo) => {
    const gateway = await addPushMonitor(page, "Dependency Gateway");
    const service = await addPushMonitor(page, "Dependent Service", gateway.id);
    const detailsIndicator = page
        .locator(".dependency-suppression")
        .filter({ has: page.locator(".suppression-label") });
    await expect(detailsIndicator).toHaveCount(0);
    await push(request, gateway.url, "down");
    await push(request, service.url, "down");
    await expect(page.getByTestId("monitor-status")).toContainText("Down");
    const label = page.locator(".suppression-label").last();
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute("aria-label", /Dependency Gateway is down/);
    await expect(page.getByTestId("monitor-list").locator(".suppression-label")).toHaveCount(1);
    await label.focus();
    await expect(page.locator(".suppression-explanation")).toContainText("Dependency Gateway is down");
    await label.press("Escape");
    await expect(page.locator(".suppression-explanation")).toHaveCount(0);
    await page.goto("./dashboard");
    // History/reconnect has no live metadata; it must not claim current suppression.
    await expect(page.locator(".suppression-label")).toHaveCount(0);
    await push(request, service.url, "down");
    await expect(page.locator(".suppression-label")).toHaveCount(2);
    await expect(page.locator(".num.text-danger")).toHaveText("2");
    await expect(page.getByTestId("monitor-list").locator(".suppression-label")).toBeVisible();
    await screenshot(testInfo, page);
    await page.screenshot({ path: testInfo.outputPath("dependency-dashboard.png"), animations: "disabled" });
    await page.getByRole("link", { name: "Dependent Service", exact: true }).last().click();
    await expect(page.getByTestId("monitor-status")).toContainText("Down");
    await page.evaluate(() => {
        document.body.classList.add("dark");
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveClass(/mobile/);
    await expect
        .poll(async () => {
            const bounds = await page.locator(".suppression-label").last().boundingBox();
            return bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390;
        })
        .toBe(true);
    await screenshot(testInfo, page);
    await page.screenshot({ path: testInfo.outputPath("dependency-mobile-dark.png"), animations: "disabled" });
    await push(request, gateway.url, "up");
    await expect(page.locator(".suppression-label")).toHaveCount(0);
    await expect(page.getByTestId("monitor-status")).toContainText("Down");
    await push(request, service.url, "down");
    await expect(page.locator(".suppression-label")).toHaveCount(0);
    await push(request, gateway.url, "down");
    await push(request, service.url, "down");
    await expect(page.locator(".suppression-label").last()).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.locator(".suppression-label")).toHaveCount(0);
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.locator(".suppression-label")).toHaveCount(0);
});

test("escapes dependency names and keeps translated/RTL fallback indicators usable", async ({
    page,
    request,
}, testInfo) => {
    const name = '<img src=x onerror="window.dependencyInjected=true"> بوابة الشبكة ' + "Long gateway name ".repeat(5);
    const gateway = await addPushMonitor(page, name);
    const service = await addPushMonitor(page, "Locale service", gateway.id);
    await page.evaluate(() => {
        localStorage.locale = "ar-SY";
    });
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ animations: "disabled" });
    await push(request, gateway.url, "down");
    await push(request, service.url, "down");
    const label = page.locator(".suppression-label").last();
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute(
        "aria-label",
        `Failure alerts suppressed because ${name} is down. Health checks and monitor status are unchanged.`
    );
    await label.focus();
    await page.evaluate(() => window.scrollTo(0, 0));
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText(name);
    await expect(tooltip.locator("img")).toHaveCount(0);
    await expect
        .poll(async () => {
            const box = await page.locator(".tooltip-wrapper").boundingBox();
            return box && box.x >= 0 && box.x + box.width <= 390;
        })
        .toBe(true);
    expect(await page.evaluate(() => window.dependencyInjected)).toBeUndefined();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const bounds = await label.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("dependency-rtl.png"), animations: "disabled" });
    await screenshot(testInfo, page);
});

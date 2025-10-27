from playwright.sync_api import sync_playwright, expect
import os

def run_test():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        # Navigate to the local HTML file
        file_path = os.path.abspath('Feedback.html')
        page.goto(f'file://{file_path}')

        # Fill out the form to enable the main content
        page.fill('#studentCode', 'test-user')
        page.fill('#cohort', 'test-cohort')
        page.check('#consent')
        page.click('#saveProfileBtn')

        # Wait for the main content to be fully visible
        main_content = page.locator('#mainContent')
        expect(main_content).to_have_css('opacity', '1', timeout=5000)

        # Now, open the recording modal
        declic_button = page.locator('button[data-topic="declic"]')
        declic_button.click()

        # Override the MAX_SECONDS limit for the test, now that the app is initialized
        page.evaluate('() => { CONFIG.LIMITS.MAX_SECONDS = 2; }')

        # Start and then pause recording
        page.click('#btnRecord')
        page.wait_for_timeout(1000) # record for 1 second
        page.click('#btnPause')

        # Resume recording and wait for the timeout toast
        page.click('#btnResume')

        # Wait for the toast to appear - the toast for timeout is amber/warn
        toast_locator = page.locator("div#toasts div.bg-amber-500")
        expect(toast_locator).to_be_visible(timeout=5000)

        # Take a screenshot
        page.screenshot(path='jules-scratch/verification/verification.png')

        browser.close()
        print("Screenshot created successfully.")

if __name__ == '__main__':
    run_test()

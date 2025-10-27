from playwright.sync_api import sync_playwright, expect
import os

def run_test():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        # Navigate to the local HTML file
        file_path = os.path.abspath('Feedback.html')
        page.goto(f'file://{file_path}')

        # Fill out the form
        page.fill('#studentCode', 'test-user')
        page.fill('#cohort', 'test-cohort')
        page.check('#consent')

        # Click the button
        page.click('#saveProfileBtn')

        # Wait for the main content to be visible
        main_content = page.locator('#mainContent')
        expect(main_content).to_have_css('opacity', '1', timeout=5000)

        # Take a screenshot
        page.screenshot(path='jules-scratch/verification/form-submission.png')

        browser.close()
        print("Screenshot created successfully.")

if __name__ == '__main__':
    run_test()

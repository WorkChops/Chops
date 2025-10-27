from playwright.sync_api import sync_playwright, expect
import os

def run_test():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        # Handle the confirm dialog
        page.on("dialog", lambda dialog: dialog.dismiss())

        # Navigate to the local HTML file
        file_path = os.path.abspath('Feedback.html')
        page.goto(f'file://{file_path}')

        # Fill out the form to enable the main content
        page.fill('#studentCode', 'test-user')
        page.fill('#cohort', 'test-cohort')
        page.check('#consent')
        page.click('#saveProfileBtn')

        # Wait for the main content to be visible
        main_content = page.locator('#mainContent')
        expect(main_content).to_have_css('opacity', '1', timeout=5000)

        # Open the recording modal
        page.click('button[data-topic="declic"]')

        # Start recording
        page.click('#btnRecord')
        page.wait_for_timeout(1000) # record for 1 second

        # Attempt to close the modal
        page.click('#modalClose')

        # Check if the modal is still visible
        expect(page.locator('#recordModal')).to_be_visible()

        # Take a screenshot
        page.screenshot(path='jules-scratch/verification/modal-still-open.png')

        browser.close()
        print("Test finished, screenshot created.")

if __name__ == '__main__':
    run_test()

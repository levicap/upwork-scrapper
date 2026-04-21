import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from bs4 import BeautifulSoup
import time
import os
import pickle
import json
import threading
from flask import Flask, request, jsonify
import logging
from datetime import datetime
from contextlib import contextmanager

class UpworkScraper:
    def __init__(self):
        self.driver = None
        self.driver_lock = threading.Lock()
        self.cookies_dir = "cookies"
        self.logs_dir = "logs"
        self.current_profile = None
        self.max_retries = 3
        self.setup_directories()
        self.setup_logging()
        
    def setup_directories(self):
        """Create necessary directories if they don't exist."""
        for directory in [self.cookies_dir, self.logs_dir]:
            if not os.path.exists(directory):
                os.makedirs(directory)
                
    def setup_logging(self):
        """Configure logging with debug mode enabled."""
        logging.basicConfig(
            level=logging.DEBUG,
            format='%(asctime)s - %(levelname)s - %(name)s - %(threadName)s - %(message)s',
            handlers=[
                logging.FileHandler(os.path.join(self.logs_dir, 'debug.log')),
                logging.StreamHandler()  # Also log to console
            ]
        )
        self.logger = logging.getLogger(__name__)
        
    def is_driver_alive(self):
        """Check if the driver is still alive and responsive."""
        if not self.driver:
            return False
        
        try:
            # Try to get the current URL to test if driver is responsive
            _ = self.driver.current_url
            return True
        except Exception as e:
            self.logger.warning(f"Driver is not responsive: {e}")
            return False
    
    @contextmanager
    def get_driver(self):
        """Context manager to safely get and use the driver with thread safety."""
        self.logger.debug("Acquiring driver lock...")
        
        with self.driver_lock:
            try:
                self.logger.debug("Driver lock acquired")
                
                # Check if driver is alive, restart if needed
                if not self.is_driver_alive():
                    self.logger.info("Driver is not alive, restarting...")
                    if not self.restart_driver():
                        raise Exception("Failed to restart driver")
                
                yield self.driver
                
            except Exception as e:
                self.logger.error(f"Error in driver context manager: {e}")
                # Try to restart driver for next use
                try:
                    self.restart_driver()
                except Exception as restart_error:
                    self.logger.error(f"Failed to restart driver after error: {restart_error}")
                raise
            finally:
                self.logger.debug("Driver lock released")
    
    def restart_driver(self):
        """Restart the driver and reload the current profile."""
        self.logger.info("Restarting driver...")
        
        # Clean up old driver
        if self.driver:
            try:
                self.driver.quit()
            except:
                pass
        
        # Reinitialize driver
        try:
            options = uc.ChromeOptions()
            options.add_argument("--disable-blink-features=AutomationControlled")
            options.add_argument("--disable-web-security")
            options.add_argument("--allow-running-insecure-content")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-gpu")
            options.add_argument("--remote-debugging-port=9222")
            
            self.driver = uc.Chrome(options=options, version_main=146)
            self.logger.info("Driver restarted successfully")
            
            # Reload current profile if available
            if self.current_profile:
                self.logger.info(f"Reloading profile: {self.current_profile}")
                self.load_existing_profile(self.current_profile)
                
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to restart driver: {e}")
            return False
                
    def save_cookies(self, profile_name):
        """Save cookies to a file for a given profile."""
        try:
            profile_dir = os.path.join(self.cookies_dir, profile_name)
            if not os.path.exists(profile_dir):
                os.makedirs(profile_dir)
            
            cookie_file = os.path.join(profile_dir, "cookies.pkl")
            with open(cookie_file, "wb") as f:
                pickle.dump(self.driver.get_cookies(), f)
            
            self.logger.info(f"Cookies saved for profile: {profile_name}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to save cookies for profile {profile_name}: {e}")
            return False

    def load_cookies(self, profile_name):
        """Load cookies from a file for a given profile."""
        try:
            cookie_file = os.path.join(self.cookies_dir, profile_name, "cookies.pkl")
            if os.path.exists(cookie_file):
                with open(cookie_file, "rb") as f:
                    cookies = pickle.load(f)
                
                for cookie in cookies:
                    try:
                        self.driver.add_cookie(cookie)
                    except Exception as e:
                        self.logger.debug(f"Failed to add cookie: {e}")
                
                self.logger.info(f"Cookies loaded for profile: {profile_name}")
                return True
            else:
                self.logger.warning(f"Cookie file not found for profile: {profile_name}")
                return False
        except Exception as e:
            self.logger.error(f"Failed to load cookies for profile {profile_name}: {e}")
            return False

    def get_available_profiles(self):
        """Get list of available cookie profiles."""
        if not os.path.exists(self.cookies_dir):
            return []
        
        profiles = [d for d in os.listdir(self.cookies_dir) 
                   if os.path.isdir(os.path.join(self.cookies_dir, d))]
        return profiles

    def create_new_profile(self, profile_name):
        """Create a new profile by logging in."""
        try:
            self.logger.info(f"Creating new profile: {profile_name}")
            self.driver.get("https://www.upwork.com/nx/login/")
            
            print("Please log in to your Upwork account in the browser.")
            input("Press Enter after you have logged in...")
            
            if self.save_cookies(profile_name):
                self.current_profile = profile_name  # Store current profile
                self.logger.info(f"New profile '{profile_name}' created successfully")
                return True
            else:
                self.logger.error(f"Failed to create profile '{profile_name}'")
                return False
        except Exception as e:
            self.logger.error(f"Error creating new profile: {e}")
            return False

    def load_existing_profile(self, profile_name):
        """Load an existing profile."""
        try:
            self.logger.info(f"Loading existing profile: {profile_name}")
            self.driver.get("https://www.upwork.com/")
            
            if self.load_cookies(profile_name):
                self.driver.refresh()  # Refresh to apply cookies
                self.current_profile = profile_name  # Store current profile
                self.logger.info(f"Profile '{profile_name}' loaded successfully")
                return True
            else:
                self.logger.error(f"Failed to load profile '{profile_name}'")
                return False
        except Exception as e:
            self.logger.error(f"Error loading profile: {e}")
            return False

    def init_browser(self):
        """Initialize the browser and handle login."""
        try:
            self.logger.info("Initializing browser...")
            
            options = uc.ChromeOptions()
            options.add_argument("--disable-blink-features=AutomationControlled")
            options.add_argument("--disable-web-security")
            options.add_argument("--allow-running-insecure-content")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-gpu")
            options.add_argument("--remote-debugging-port=9222")
            options.add_argument("--disable-extensions")
            options.add_argument("--disable-plugins")
            
            self.driver = uc.Chrome(options=options, version_main=146)
            self.logger.info("Browser initialized successfully")
            
            profiles = self.get_available_profiles()
            
            if profiles:
                print("\nAvailable cookie profiles:")
                for i, profile in enumerate(profiles):
                    print(f"{i+1}. {profile}")
                print(f"{len(profiles)+1}. Create a new profile")
                
                while True:
                    try:
                        choice = input("\nChoose a profile to use: ")
                        choice_index = int(choice) - 1
                        
                        if 0 <= choice_index < len(profiles):
                            profile_name = profiles[choice_index]
                            if self.load_existing_profile(profile_name):
                                break
                        elif choice_index == len(profiles):
                            profile_name = input("Enter a name for the new profile: ")
                            if self.create_new_profile(profile_name):
                                break
                        else:
                            print("Invalid choice. Please try again.")
                            
                    except (ValueError, KeyboardInterrupt):
                        print("Invalid input or interrupted. Exiting.")
                        self.cleanup()
                        exit()
            else:
                profile_name = input("No profiles found. Enter a name for a new profile: ")
                if not self.create_new_profile(profile_name):
                    self.cleanup()
                    exit()
            
            self.logger.info("Browser initialization completed")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize browser: {e}")
            self.cleanup()
            raise

    def scrape_job_url(self, url):
        """Scrape job data from Upwork URL with retry logic."""
        self.logger.debug(f"Starting to scrape URL: {url}")
        
        if not url.startswith("https://www.upwork.com/"):
            raise ValueError("Please enter a valid Upwork URL.")
        
        for attempt in range(self.max_retries):
            try:
                self.logger.debug(f"Attempt {attempt + 1}/{self.max_retries} for URL: {url}")
                
                with self.get_driver() as driver:
                    self.logger.debug("Navigating to URL...")
                    driver.get(url)
                    
                    # Wait for dynamic content to load
                    self.logger.debug("Waiting for content to load...")
                    time.sleep(5)  # Increased wait time
                    
                    # Try to wait for the page to be fully loaded
                    try:
                        WebDriverWait(driver, 10).until(
                            lambda d: d.execute_script("return document.readyState") == "complete"
                        )
                    except Exception as e:
                        self.logger.warning(f"Page load timeout: {e}")
                    
                    soup = BeautifulSoup(driver.page_source, 'lxml')
                    
                    # Try to find <pre> tag that contains the JSON
                    pre_tag = soup.find('pre')
                    
                    if pre_tag and pre_tag.string:
                        try:
                            self.logger.debug("Found JSON in <pre> tag, parsing...")
                            json_data = json.loads(pre_tag.string)
                            self.logger.info(f"Successfully scraped data from: {url}")
                            return json_data
                        except json.JSONDecodeError as e:
                            self.logger.error(f"Failed to parse JSON: {e}")
                            if attempt == self.max_retries - 1:
                                raise ValueError(f"Found JSON in <pre> but failed to parse: {str(e)}")
                    else:
                        self.logger.warning("Could not find <pre> tag with JSON")
                        if attempt == self.max_retries - 1:
                            # Save HTML for debugging
                            self.save_debug_html(driver.page_source)
                            raise ValueError("Could not find <pre> tag with JSON.")
                
                # If we get here, there was an issue but we should retry
                self.logger.warning(f"Attempt {attempt + 1} failed, retrying...")
                time.sleep(2)  # Wait before retry
                
            except Exception as e:
                self.logger.error(f"Error on attempt {attempt + 1}: {e}")
                if attempt == self.max_retries - 1:
                    raise
                else:
                    self.logger.info(f"Retrying in 2 seconds... ({attempt + 1}/{self.max_retries})")
                    time.sleep(2)
        
        raise Exception(f"Failed to scrape URL after {self.max_retries} attempts")

    def scrape_job_url_simple(self, url):
        """Alternative simpler approach without context manager."""
        self.logger.debug(f"Starting to scrape URL: {url}")
        
        if not url.startswith("https://www.upwork.com/"):
            raise ValueError("Please enter a valid Upwork URL.")
        
        for attempt in range(self.max_retries):
            try:
                self.logger.debug(f"Attempt {attempt + 1}/{self.max_retries} for URL: {url}")
                
                with self.driver_lock:
                    # Check if driver is alive, restart if needed
                    if not self.is_driver_alive():
                        self.logger.info("Driver is not alive, restarting...")
                        if not self.restart_driver():
                            raise Exception("Failed to restart driver")
                    
                    self.logger.debug("Navigating to URL...")
                    self.driver.get(url)
                    
                    # Wait for dynamic content to load
                    self.logger.debug("Waiting for content to load...")
                    time.sleep(5)
                    
                    # Try to wait for the page to be fully loaded
                    try:
                        WebDriverWait(self.driver, 10).until(
                            lambda d: d.execute_script("return document.readyState") == "complete"
                        )
                    except Exception as e:
                        self.logger.warning(f"Page load timeout: {e}")
                    
                    soup = BeautifulSoup(self.driver.page_source, 'lxml')
                    
                    # Try to find <pre> tag that contains the JSON
                    pre_tag = soup.find('pre')
                    
                    if pre_tag and pre_tag.string:
                        try:
                            self.logger.debug("Found JSON in <pre> tag, parsing...")
                            json_data = json.loads(pre_tag.string)
                            self.logger.info(f"Successfully scraped data from: {url}")
                            return json_data
                        except json.JSONDecodeError as e:
                            self.logger.error(f"Failed to parse JSON: {e}")
                            if attempt == self.max_retries - 1:
                                raise ValueError(f"Found JSON in <pre> but failed to parse: {str(e)}")
                    else:
                        self.logger.warning("Could not find <pre> tag with JSON")
                        if attempt == self.max_retries - 1:
                            # Save HTML for debugging
                            self.save_debug_html(self.driver.page_source)
                            raise ValueError("Could not find <pre> tag with JSON.")
                
                # If we get here, there was an issue but we should retry
                self.logger.warning(f"Attempt {attempt + 1} failed, retrying...")
                time.sleep(2)
                
            except Exception as e:
                self.logger.error(f"Error on attempt {attempt + 1}: {e}")
                if attempt == self.max_retries - 1:
                    raise
                else:
                    self.logger.info(f"Retrying in 2 seconds... ({attempt + 1}/{self.max_retries})")
                    time.sleep(2)
        
        raise Exception(f"Failed to scrape URL after {self.max_retries} attempts")

    def save_debug_html(self, html_content):
        """Save HTML content for debugging purposes."""
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = os.path.join(self.logs_dir, f"debug_response_{timestamp}.html")
        
        try:
            with open(filename, "w", encoding="utf-8") as f:
                f.write(html_content)
            self.logger.debug(f"Debug HTML saved to: {filename}")
        except Exception as e:
            self.logger.error(f"Failed to save debug HTML: {e}")

    def cleanup(self):
        """Clean up resources."""
        self.logger.info("Cleaning up resources...")
        if self.driver:
            try:
                self.driver.quit()
                self.logger.info("Browser closed successfully")
            except Exception as e:
                self.logger.error(f"Error closing browser: {e}")


# Flask Application
app = Flask(__name__)
scraper = UpworkScraper()

@app.route('/api/job_url', methods=['GET'])
def api_scrape_job_url():
    """API endpoint to scrape job URLs with enhanced error handling."""
    scraper.logger.info(f"API request received from {request.remote_addr}")
    
    url = request.args.get('url')
    if not url:
        scraper.logger.warning("API request missing URL parameter")
        return jsonify({"error": "URL parameter is required"}), 400
    
    scraper.logger.info(f"Processing URL: {url}")
    
    try:
        result = scraper.scrape_job_url(url)
        scraper.logger.info("API request completed successfully")
        return jsonify(result)
        
    except ValueError as e:
        scraper.logger.warning(f"Validation error: {e}")
        return jsonify({"error": str(e)}), 400
        
    except Exception as e:
        scraper.logger.error(f"Unexpected error in API: {e}", exc_info=True)
        
        # Try to restart driver for next request
        try:
            scraper.restart_driver()
            scraper.logger.info("Driver restarted after error")
        except Exception as restart_error:
            scraper.logger.error(f"Failed to restart driver: {restart_error}")
        
        return jsonify({
            "error": "An unexpected error occurred. Driver has been restarted. Please try again.",
            "timestamp": datetime.now().isoformat(),
            "retry_suggested": True
        }), 500

@app.route('/api/status', methods=['GET'])
def api_status():
    """API endpoint to check scraper status."""
    driver_alive = scraper.is_driver_alive()
    return jsonify({
        "status": "running",
        "driver_available": scraper.driver is not None,
        "driver_alive": driver_alive,
        "current_profile": scraper.current_profile,
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/restart', methods=['POST'])
def api_restart_driver():
    """API endpoint to manually restart the driver."""
    try:
        scraper.logger.info("Manual driver restart requested")
        success = scraper.restart_driver()
        return jsonify({
            "success": success,
            "message": "Driver restarted successfully" if success else "Failed to restart driver",
            "timestamp": datetime.now().isoformat()
        })
    except Exception as e:
        scraper.logger.error(f"Error restarting driver: {e}")
        return jsonify({
            "success": False,
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/health', methods=['GET'])
def api_health():
    """Health check endpoint."""
    return jsonify({"status": "healthy"})


def main():
    """Main execution function."""
    try:
        scraper.logger.info("Starting Upwork Scraper Application")
        scraper.init_browser()
        
        scraper.logger.info("Starting Flask server on 0.0.0.0:5000")
        app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
        
    except KeyboardInterrupt:
        scraper.logger.info("Application interrupted by user")
    except Exception as e:
        scraper.logger.error(f"Application error: {e}", exc_info=True)
    finally:
        scraper.cleanup()


if __name__ == "__main__":
    main()
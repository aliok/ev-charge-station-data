#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

echo "--- Running EV Station Data Fetch Script ---"

# Execute the Node.js script
# If this script exits with a non-zero status (as designed in your JS),
# 'set -e' will cause this bash script to exit immediately, failing the workflow step.
node index.js

echo "--- Script Execution Finished ---"

# --- Check for Changes and Commit ---
# Use 'git status --porcelain' which provides easily parsable output.
# We specifically check the 'state/' and 'output/' directories.
echo "Checking for changes in 'state/' and 'output/' directories..."
if [[ -z $(git status --porcelain state/ output/) ]]; then
    echo "No changes detected in 'state/' or 'output/'. Nothing to commit."
else
    echo "Changes detected in 'state/' and/or 'output/'. Proceeding with commit."

    # Configure Git user for this commit
    # Uses the standard GitHub Actions bot user
    git config --global user.name 'github-actions[bot]'
    git config --global user.email 'github-actions[bot]@users.noreply.github.com'

    # Add all changes within the 'state' and 'output' directories
    git add state/ output/

    # Create a commit message including the current date
    COMMIT_DATE=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
    COMMIT_MESSAGE="Update EV station state and data ($COMMIT_DATE)"

    echo "Committing changes..."
    git commit -m "$COMMIT_MESSAGE"

    echo "Pushing changes..."
    # Assumes the workflow is configured with the correct token/permissions
    git push

    echo "Changes committed and pushed successfully."
fi

echo "--- Workflow Step Completed ---"
exit 0

#!/bin/bash

# Do NOT exit immediately on non-zero status anymore
# set -e

echo "--- Running EV Station Data Fetch Script ---"

# Execute the Node.js script and capture its exit code
node fetch-stations.js
node_exit_code=$? # Capture the exit code of the node script

echo "--- Script Execution Finished (Exit Code: $node_exit_code) ---"

# --- Check for Changes and Commit (Always Run) ---
echo "Checking for changes in 'state/', 'output/', and root 'stations.json'..."
# Include stations.json in the check now
if [[ -z $(git status --porcelain state/ output/ stations.json) ]]; then
    echo "No changes detected in relevant files. Nothing to commit."
else
    echo "Changes detected. Proceeding with commit."

    # Configure Git user for this commit
    git config --global user.name 'github-actions[bot]'
    git config --global user.email 'github-actions[bot]@users.noreply.github.com'

    # Add all changes within the specified directories and the root file
    git add state/ output/ stations.json

    # Create a commit message including the current date
    COMMIT_DATE=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
    COMMIT_MESSAGE="Update EV station state and data ($COMMIT_DATE)"
    # Optionally add exit code info to commit message if desired (can be noisy)
    # COMMIT_MESSAGE="Update EV station state and data ($COMMIT_DATE) - Script exit: $node_exit_code"

    echo "Committing changes..."
    git commit -m "$COMMIT_MESSAGE"

    echo "Pushing changes..."
    git push

    echo "Changes committed and pushed successfully."
fi

echo "--- Workflow Step Completed ---"
# Exit the bash script with the exit code from the node script
exit $node_exit_code

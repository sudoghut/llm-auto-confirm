"""Simulate LLM permission prompts for testing the extension."""
import time

print("Starting fake LLM session...")
print()

prompts = [
    "Allow Claude to run bash command: npm test?\n  Yes / No",
    "Allow Claude to read file: src/index.ts?\n  Yes / No",
    "Allow Claude to run bash command: rm -rf /?\n  Yes / No",  # dangerous - should be blocked
    "Do you want to proceed with this action? (y/n)",
]

for i, prompt in enumerate(prompts):
    time.sleep(3)
    print(f"\n--- Prompt {i+1} ---")
    print(prompt)
    response = input("> ")
    print(f"Got response: '{response}'")

print("\nDone! All prompts handled.")

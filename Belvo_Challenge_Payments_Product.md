# Belvo Challenge – Payments Product

## Objective

Design and build a minimal working product (spreadsheet, script, or app) that decides whether a collection should be retried, and when.

We’re testing how you think like a product builder: from defining data → designing logic → shaping it into a usable product artifact.

## Scenario

Belvo’s Managed Collections product helps lenders automatically collect loan repayments from their customers’ bank accounts, maximizing portfolio recovery. Each day, merchants share a list of loans and Belvo’s operations team creates payment requests that are sent through banking rails in order to recover as much funds as possible from what’s owed.

Payments are currently retried without much discretion, often triggering unnecessary chargebacks or wasting bandwidth on accounts with no funds, that are blocked, etc.

Your task is to design a smarter retry mechanism that decides when a loan should be retried, and which loans are worth retrying at all.

## The Task

Build an MVP Smart Retry System using your preferred medium:

* A Google Sheet / Excel prototype with dynamic formulas and decision logic, or

* A simple script or lightweight app (e.g. Python, JS, Streamlit, Flask) that ingests a dataset and outputs retry decisions.

* A SQL-based approach that models the retry decision logic directly from a dataset.

Either way, we want to see both the product experience and the underlying logic.

## Inputs

As inputs, you will receive 2 files:

* One file will contain the information about the hypothetical loan portfolio of a client

* The second file will contain the transactions that have been performed in the past to these loans

Assume the loan portfolio is updated, previous payments should not modify in any case the status of the loan portfolio

## Deliverables

### Build the Smart Retry Product

* Take the dataset as input (e.g., a CSV, a Sheet tab, or API payload)

* Apply retry logic based on your chosen heuristics.

* Output a decision.

You can make this work inside:

* A spreadsheet with formulas and rules,

* A small app / script that reads and writes data, or

* A SQL query with rules

### Show the Product Layer

Explain or demonstrate how a Belvo operator would interact with this MVP.

* What does the user see? (table, buttons, config section, dashboard?)

* Would they configure retry parameters?

* How would this evolve into a scalable Belvo product?

### Explain the Logic & Tradeoffs

* The principles behind your retry logic (e.g., time since last success, customer risk score, failure reason).

* What are the trade-offs?

* What you’d test or measure if this went live.

## Long term vision

* Create a simple presentation for the product in the existing status

* Define what would be the next steps and the strategy we would follow in the long term, where do you see this product in 2-5 years?

* What would be the next steps you would implement to bring this to market?

## Submission Guidelines

Submit:

* Your dataset (CSV, Sheet, or generator code)

* The product artifact (Sheet link, notebook, or app link)

* A short summary (≤1 page) explaining your approach

## What We’re Looking For

| Signal | Description |
| :--- | :--- |
| Builder’s Mindset | Creates something tangible and working, not just theory. |
| Data Intuition | Can reason about what matters in a payments dataset. |
| Technical Fluency | Expresses logic in clear, structured pseudocode or queries. |
| Product Sense | Connects logic to merchant impact and operational constraints. |
| Risk Awareness | Recognizes edge cases like chargebacks or over-retries. |

## Message to Candidates

This isn’t about polished UI or syntax perfection.

We want to see how you think like a product builder: creating something tangible, data-driven, and usable. Use whatever tools you’re comfortable with, spreadsheet, SQL, script, or mini-app, show us your reasoning end-to-end.

#!/usr/bin/env node
// Example evalCommand: prints a single JSON object of { [metricKey]: number }
// on stdout. The kernel parses the last JSON object on stdout, records a
// MetricSample per key, and uses each metric's direction to judge a change.
//
// A real eval would run the project's test suite and compute these numbers;
// here we emit static demo values.
console.log(JSON.stringify({ coverage: 0.42, lintErrors: 3 }));

#!/bin/sh
# Unix compatibility wrapper; Windows uses the Node entrypoint directly.
exec node "$(dirname "$0")/checkpoint.js" "$@"

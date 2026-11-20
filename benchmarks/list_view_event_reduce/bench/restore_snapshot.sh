#!/bin/bash
# Puts the site database back to the snapshot taken after seeding, so that every
# benchmark run starts from the same invoices.
#   bench/restore_snapshot.sh <db name> <snapshot.sql.gz> [mariadb root password]
set -e
gunzip -c "$2" | mariadb -uroot -p"${3:-root}" "$1"
redis-cli -n 1 flushdb > /dev/null
echo "restored $1 from $2"

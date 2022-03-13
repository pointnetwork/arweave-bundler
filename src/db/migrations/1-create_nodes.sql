CREATE TABLE arweave_nodes (
    rowid INTEGER PRIMARY KEY,
    host varchar (255) NOT NULL,
    port integer NOT NULL,
    status varchar (255) NOT NULL DEFAULT 'unknown'
)

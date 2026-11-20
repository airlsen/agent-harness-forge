"""Example enterprise Worker. Put a trusted HTTPS gateway in front in production."""

from forge_sdk import serve


def find_contact(args: dict) -> dict:
    query = args.get("query")
    if not isinstance(query, str) or not 1 <= len(query) <= 120:
        raise ValueError("query must be 1–120 characters")
    # Replace with the enterprise CRM client. Its credentials stay in this service.
    return {"contacts": [{"name": "示例客户", "match": query}]}


if __name__ == "__main__":
    serve({"acme_find_contact": find_contact}, credential_env="FORGE_PLUGIN_AUTH_ACME_CONTACTS")

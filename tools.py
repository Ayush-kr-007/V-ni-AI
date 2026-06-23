import logging

logger = logging.getLogger(__name__)

async def search_flights(origin: str, destination: str, date: str) -> str:
    """Search for available flights between two locations on a specific date.
    
    Args:
        origin: Departure airport code or city name.
        destination: Arrival airport code or city name.
        date: Date of travel (YYYY-MM-DD format).
    """
    logger.info(f"Executing search_flights tool: {origin} -> {destination} on {date}")
    
    # Clean structured response layout that the model can interpret
    return (
        f"Found 2 flights from {origin} to {destination} on {date}: "
        f"1. American Airlines AA-104 departing at 08:15 AM for $340. "
        f"2. Delta Air Lines DL-782 departing at 03:45 PM for $295."
    )

# Modern google-genai layout: Pass raw function references directly
tools_list = [search_flights]

tool_mapping = {
    "search_flights": search_flights
}